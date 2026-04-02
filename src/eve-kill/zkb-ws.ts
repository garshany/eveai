/**
 * zKillboard WebSocket client for real-time kill notifications.
 *
 * URL: wss://zkillboard.com/websocket/
 * Protocol: JSON frames, requires Origin header
 * Channels: system:{id}, character:{id}, region:{id}, killstream, public
 *
 * Used by kill_watch subscriptions for instant alerts.
 */

import WebSocket from 'ws';
import type { Db } from '../db/sqlite.js';

const LOG = '[zkb-ws]';
const WS_URL = 'wss://zkillboard.com/websocket/';
const WS_HEADERS = {
  'User-Agent': 'EVEAIBOT/1.0 garshany80@gmail.com',
  'Origin': 'https://zkillboard.com',
};
const MAX_RECONNECT_MS = 300_000; // 5 min max backoff

type NotifySender = (chatId: number, text: string) => void;

type ZkbKillMessage = {
  killmail_id: number;
  solar_system_id?: number;
  killmail_time?: string;
  victim?: {
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    ship_type_id?: number;
  };
  attackers?: Array<{
    character_id?: number;
    final_blow?: boolean;
  }>;
  zkb?: {
    totalValue?: number;
    npc?: boolean;
    solo?: boolean;
  };
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closed = false;
let connected = false;

let watchDb: Db | null = null;
let sender: NotifySender | null = null;

// Active channels subscribed on zKB side
const activeChannels = new Set<string>();

// Dedup
const recentNotifs = new Map<string, number>();
const DEDUP_TTL_MS = 120_000;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startZkbWs(db: Db, notifySender: NotifySender): void {
  watchDb = db;
  sender = notifySender;
  closed = false;
  connect();

  // Load existing watches from DB and subscribe channels
  const rows = db.prepare('SELECT DISTINCT topic FROM kill_watches').all() as Array<{ topic: string }>;
  for (const { topic } of rows) {
    const channel = topicToChannel(topic);
    if (channel) activeChannels.add(channel);
  }
  console.log(`${LOG} initialized with ${activeChannels.size} channels from DB`);
}

export function stopZkbWs(): void {
  closed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(1000); } catch { /* */ }
    ws = null;
  }
  connected = false;
  console.log(`${LOG} stopped`);
}

// ---------------------------------------------------------------------------
// Topic ↔ Channel mapping
// ---------------------------------------------------------------------------

// Our topics: system.30000142, victim.268946627, attacker.268946627, region.10000002
// zKB channels: system:30000142, character:268946627, region:10000002

function topicToChannel(topic: string): string | null {
  const [type, id] = topic.split('.');
  if (!type || !id) return null;
  switch (type) {
    case 'system': return `system:${id}`;
    case 'region': return `region:${id}`;
    case 'victim': return `character:${id}`;   // zKB character channel covers both kills and losses
    case 'attacker': return `character:${id}`;
    default: return null;
  }
}

export function subscribeTopics(topics: string[]): void {
  for (const topic of topics) {
    const channel = topicToChannel(topic);
    if (!channel || activeChannels.has(channel)) continue;
    activeChannels.add(channel);
    if (connected && ws) {
      ws.send(JSON.stringify({ action: 'sub', channel }));
      console.log(`${LOG} sub ${channel}`);
    }
  }
}

export function unsubscribeTopics(topics: string[]): void {
  for (const topic of topics) {
    const channel = topicToChannel(topic);
    if (!channel || !activeChannels.has(channel)) continue;
    activeChannels.delete(channel);
    if (connected && ws) {
      ws.send(JSON.stringify({ action: 'unsub', channel }));
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect(): void {
  if (closed || ws) return;

  console.log(`${LOG} connecting...`);
  ws = new WebSocket(WS_URL, { headers: WS_HEADERS });

  ws.on('open', () => {
    console.log(`${LOG} connected`);
    connected = true;
    reconnectDelay = 1000;

    // Subscribe all active channels
    for (const channel of activeChannels) {
      ws!.send(JSON.stringify({ action: 'sub', channel }));
    }
    if (activeChannels.size > 0) {
      console.log(`${LOG} subscribed ${activeChannels.size} channels`);
    }
  });

  ws.on('message', (data) => {
    handleMessage(data.toString());
  });

  ws.on('close', (code) => {
    connected = false;
    ws = null;
    if (!closed) {
      console.log(`${LOG} disconnected (${code}), reconnecting in ${Math.round(reconnectDelay / 1000)}s`);
      scheduleReconnect();
    }
  });

  ws.on('error', (err) => {
    console.error(`${LOG} error: ${err.message}`);
  });
}

function scheduleReconnect(): void {
  if (closed || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    connect();
  }, reconnectDelay);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(raw: string): void {
  if (!watchDb || !sender) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch { return; }

  // Skip non-kill messages (tqStatus, etc.)
  if (!msg.killmail_id) return;

  const kill = msg as unknown as ZkbKillMessage;

  // Skip NPC
  if (kill.zkb?.npc) return;

  // Skip old kills
  if (kill.killmail_time) {
    const age = Date.now() - new Date(kill.killmail_time).getTime();
    if (age > 600_000 || age < -60_000) return; // >10min old or future
  }

  // Match against watches
  notifyWatchers(watchDb, kill);
}

function notifyWatchers(db: Db, kill: ZkbKillMessage): void {
  // Build matching topics
  const topics: string[] = [];
  if (kill.solar_system_id) topics.push(`system.${kill.solar_system_id}`);
  if (kill.victim?.character_id) topics.push(`victim.${kill.victim.character_id}`);
  for (const atk of kill.attackers ?? []) {
    if (atk.character_id) topics.push(`attacker.${atk.character_id}`);
  }
  if (topics.length === 0) return;

  const placeholders = topics.map(() => '?').join(',');
  const watchers = db.prepare(
    `SELECT DISTINCT chat_id FROM kill_watches WHERE topic IN (${placeholders})`,
  ).all(...topics) as Array<{ chat_id: number }>;

  if (watchers.length === 0) return;

  // Format alert
  const value = kill.zkb?.totalValue ? Math.round(kill.zkb.totalValue / 1_000_000) : 0;
  const shipName = resolveType(db, kill.victim?.ship_type_id ?? null) ?? '?';
  const systemName = resolveSystem(db, kill.solar_system_id ?? 0);
  const soloTag = kill.zkb?.solo ? ' [SOLO]' : '';
  const text = `🔴 Kill in ${systemName}${soloTag}: ${shipName} lost (${value}M ISK)\nhttps://zkillboard.com/kill/${kill.killmail_id}/`;

  // Dedup + send
  const now = Date.now();
  if (recentNotifs.size > 500) {
    for (const [k, ts] of recentNotifs) { if (now - ts > DEDUP_TTL_MS) recentNotifs.delete(k); }
  }

  for (const { chat_id } of watchers) {
    const key = `${chat_id}:${kill.killmail_id}`;
    if (recentNotifs.has(key)) continue;
    recentNotifs.set(key, now);
    try { sender!(chat_id, text); } catch { /* */ }
  }

  console.log(`${LOG} kill ${kill.killmail_id} → ${watchers.length} chats`);
}

// ---------------------------------------------------------------------------
// SDE helpers
// ---------------------------------------------------------------------------

const typeCache = new Map<number, string | null>();
function resolveType(db: Db, typeId: number | null): string | null {
  if (!typeId) return null;
  if (typeCache.has(typeId)) return typeCache.get(typeId)!;
  const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  const name = row?.name ?? null;
  typeCache.set(typeId, name);
  return name;
}

function resolveSystem(db: Db, systemId: number): string {
  const row = db.prepare('SELECT name FROM sde_systems WHERE system_id = ?').get(systemId) as { name: string } | undefined;
  return row?.name ?? `System ${systemId}`;
}
