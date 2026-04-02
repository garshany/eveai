/**
 * zKillboard WebSocket — real-time kill notifications.
 *
 * URL: wss://zkillboard.com/websocket/
 * Requires ws package for custom headers (User-Agent, Origin).
 *
 * Channels:
 *   system:{id}     — kills in specific system
 *   character:{id}  — kills involving character
 *   region:{id}     — kills in region
 *   all:*           — all kills (littlekill format)
 *
 * Message format (littlekill):
 *   { action: "littlekill", killID, character_id, corporation_id,
 *     alliance_id, ship_type_id, group_id, url, channel }
 */

import WebSocket from 'ws';
import type { Db } from '../db/sqlite.js';

const LOG = '[zkb-ws]';
const WS_URL = 'wss://zkillboard.com/websocket/';
const RECONNECT_MAX_MS = 300_000;

type NotifySender = (chatId: number, text: string) => void;

type LittleKill = {
  action: 'littlekill';
  killID: number;
  character_id?: number;
  corporation_id?: number;
  alliance_id?: number;
  ship_type_id?: number;
  group_id?: number;
  url?: string;
  channel?: string;
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

  // Load existing watches → build channels
  const rows = db.prepare('SELECT DISTINCT topic FROM kill_watches').all() as Array<{ topic: string }>;
  for (const { topic } of rows) {
    const ch = topicToChannel(topic);
    if (ch) activeChannels.add(ch);
  }

  console.log(`${LOG} initializing with ${activeChannels.size} channels`);
  connect();
}

export function stopZkbWs(): void {
  closed = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(1000); } catch { /* */ } ws = null; }
  connected = false;
  console.log(`${LOG} stopped`);
}

// ---------------------------------------------------------------------------
// Topic ↔ Channel mapping
// ---------------------------------------------------------------------------

function topicToChannel(topic: string): string | null {
  const [type, id] = topic.split('.');
  if (!type || !id) return null;
  switch (type) {
    case 'system': return `system:${id}`;
    case 'region': return `region:${id}`;
    case 'victim':
    case 'attacker': return `character:${id}`;
    default: return null;
  }
}

export function subscribeTopics(topics: string[]): void {
  for (const topic of topics) {
    const ch = topicToChannel(topic);
    if (!ch || activeChannels.has(ch)) continue;
    activeChannels.add(ch);
    if (connected && ws) {
      ws.send(JSON.stringify({ action: 'sub', channel: ch }));
      console.log(`${LOG} sub ${ch}`);
    }
  }
}

export function unsubscribeTopics(topics: string[]): void {
  for (const topic of topics) {
    const ch = topicToChannel(topic);
    if (!ch || !activeChannels.has(ch)) continue;
    activeChannels.delete(ch);
    if (connected && ws) {
      ws.send(JSON.stringify({ action: 'unsub', channel: ch }));
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect(): void {
  if (closed || ws) return;

  console.log(`${LOG} connecting...`);
  ws = new WebSocket(WS_URL, {
    headers: {
      'User-Agent': 'EVEAIBOT/1.0 garshany80@gmail.com',
      'Origin': 'https://zkillboard.com',
    },
  });

  ws.on('open', () => {
    connected = true;
    reconnectDelay = 1000;
    console.log(`${LOG} connected`);

    // Subscribe all channels
    for (const ch of activeChannels) {
      ws!.send(JSON.stringify({ action: 'sub', channel: ch }));
    }
    if (activeChannels.size > 0) {
      console.log(`${LOG} subscribed ${activeChannels.size} channels`);
    }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.action === 'littlekill') {
        handleLittleKill(msg as unknown as LittleKill);
      }
    } catch { /* ignore parse errors */ }
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
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

// ---------------------------------------------------------------------------
// Kill handling
// ---------------------------------------------------------------------------

function handleLittleKill(kill: LittleKill): void {
  if (!watchDb || !sender) return;

  const channel = kill.channel;
  if (!channel) return;

  // Map channel back to our topic format to find watchers
  // channel = "system:30000142" or "character:268946627" or "all:*"
  const topics = channelToTopics(channel, kill);
  if (topics.length === 0) return;

  const placeholders = topics.map(() => '?').join(',');
  const watchers = watchDb.prepare(
    `SELECT DISTINCT chat_id FROM kill_watches WHERE topic IN (${placeholders})`,
  ).all(...topics) as Array<{ chat_id: number }>;

  if (watchers.length === 0) return;

  // Format alert
  const shipName = resolveType(watchDb, kill.ship_type_id ?? null) ?? '?';
  const systemName = channelSystemName(watchDb, channel);
  const url = kill.url ?? `https://zkillboard.com/kill/${kill.killID}/`;

  const text = `🔴 Kill in ${systemName}: ${shipName}\n${url}`;

  // Dedup + send
  const now = Date.now();
  if (recentNotifs.size > 500) {
    for (const [k, ts] of recentNotifs) { if (now - ts > DEDUP_TTL_MS) recentNotifs.delete(k); }
  }

  for (const { chat_id } of watchers) {
    const key = `${chat_id}:${kill.killID}`;
    if (recentNotifs.has(key)) continue;
    recentNotifs.set(key, now);
    try { sender!(chat_id, text); } catch { /* */ }
  }

  console.log(`${LOG} kill ${kill.killID} via ${channel} → ${watchers.length} chats`);
}

function channelToTopics(channel: string, kill: LittleKill): string[] {
  const [type, id] = channel.split(':');
  if (!type || !id) return [];

  switch (type) {
    case 'system': return [`system.${id}`];
    case 'region': return [`region.${id}`];
    case 'character': {
      // character channel fires for both kills and losses
      // Check if this character is victim or attacker
      const topics: string[] = [];
      if (kill.character_id?.toString() === id) {
        topics.push(`victim.${id}`, `attacker.${id}`);
      }
      return topics.length > 0 ? topics : [`victim.${id}`, `attacker.${id}`];
    }
    default: return [];
  }
}

function channelSystemName(db: Db, channel: string): string {
  const [type, id] = channel.split(':');
  if (type === 'system' && id) {
    return resolveSystem(db, Number(id));
  }
  return channel;
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
