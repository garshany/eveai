/**
 * zKillboard R2Z2 kill stream — real-time kill feed via HTTP sequence polling.
 *
 * How it works:
 *   GET /ephemeral/sequence.json → current sequence number
 *   GET /ephemeral/{seq}.json → killmail at that sequence (full ESI + zkb data)
 *   Increment seq, repeat. 2s poll when catching up, 10s when idle.
 *
 * Matches kills against kill_watches DB and sends Telegram notifications.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';

const LOG = '[zkb-r2z2]';
const BASE_URL = 'https://r2z2.zkillboard.com/ephemeral';
const POLL_ACTIVE_MS = 2_000;    // 2s when catching up
const POLL_IDLE_MS = 10_000;     // 10s when no new kills
const MAX_CATCH_UP = 30;         // Max kills per cycle
const MAX_KILL_AGE_MS = 10 * 60 * 1000;
const DEDUP_TTL_MS = 120_000;

type NotifySender = (chatId: number, text: string) => void;

// ---------------------------------------------------------------------------
// R2Z2 kill format
// ---------------------------------------------------------------------------

type R2Z2Kill = {
  killmail_id: number;
  hash?: string;
  esi?: {
    killmail_id?: number;
    killmail_time?: string;
    solar_system_id?: number;
    victim?: {
      character_id?: number;
      corporation_id?: number;
      alliance_id?: number;
      ship_type_id?: number;
    };
    attackers?: Array<{
      character_id?: number;
      corporation_id?: number;
      alliance_id?: number;
      final_blow?: boolean;
    }>;
  };
  zkb?: {
    totalValue?: number;
    npc?: boolean;
    solo?: boolean;
  };
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentSeq = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let streamDb: Db | null = null;
let streamSender: NotifySender | null = null;
let running = false;

const recentNotifs = new Map<string, number>();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startZkbWs(db: Db, sender: NotifySender): Promise<void> {
  streamDb = db;
  streamSender = sender;
  running = true;

  try {
    const res = await fetch(`${BASE_URL}/sequence.json`, {
      headers: { 'User-Agent': config.zkill.userAgent },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { sequence: number };
      currentSeq = data.sequence;
    }
  } catch (err) {
    console.error(`${LOG} failed to get initial sequence:`, (err as Error).message);
  }

  const watchCount = (db.prepare('SELECT COUNT(DISTINCT topic) as c FROM kill_watches').get() as { c: number }).c;
  console.log(`${LOG} started at seq=${currentSeq}, ${watchCount} watched topics`);

  schedulePoll(POLL_ACTIVE_MS);
}

export function stopZkbWs(): void {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log(`${LOG} stopped`);
}

// For compatibility with watch.ts subscribe/unsubscribe (no-op, R2Z2 is global stream)
export function subscribeTopics(_topics: string[]): void { /* R2Z2 receives all kills, filters locally */ }
export function unsubscribeTopics(_topics: string[]): void { /* no-op */ }

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

function schedulePoll(delay: number): void {
  if (!running) return;
  pollTimer = setTimeout(() => void pollNext(), delay);
}

async function pollNext(): Promise<void> {
  if (!running || !streamDb || !streamSender) return;

  let fetched = 0;
  let hadKill = false;

  while (fetched < MAX_CATCH_UP) {
    const kill = await fetchKill(currentSeq + 1);
    if (!kill) break;

    currentSeq++;
    fetched++;
    hadKill = true;

    if (kill.zkb?.npc) continue;
    matchAndNotify(streamDb, kill);
  }

  if (fetched > 0 && fetched % 100 === 0) {
    console.log(`${LOG} processed ${fetched} kills, seq=${currentSeq}`);
  }

  schedulePoll(hadKill ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

async function fetchKill(seq: number): Promise<R2Z2Kill | null> {
  try {
    const res = await fetch(`${BASE_URL}/${seq}.json`, {
      headers: { 'User-Agent': config.zkill.userAgent },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json() as R2Z2Kill;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Match kill against watches → notify
// ---------------------------------------------------------------------------

function matchAndNotify(db: Db, kill: R2Z2Kill): void {
  const esi = kill.esi;
  if (!esi) return;

  if (esi.killmail_time) {
    const age = Date.now() - new Date(esi.killmail_time).getTime();
    if (age > MAX_KILL_AGE_MS || age < -60_000) return;
  }

  // Build matching topics
  const topics: string[] = [];
  if (esi.solar_system_id) topics.push(`system.${esi.solar_system_id}`);
  if (esi.victim?.character_id) topics.push(`victim.${esi.victim.character_id}`);
  for (const atk of esi.attackers ?? []) {
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
  const shipName = resolveType(db, esi.victim?.ship_type_id ?? null) ?? '?';
  const systemName = resolveSystem(db, esi.solar_system_id ?? 0);
  const soloTag = kill.zkb?.solo ? ' [SOLO]' : '';
  const text = `🔴 Kill in ${systemName}${soloTag}: ${shipName} (${value}M ISK)\nhttps://zkillboard.com/kill/${kill.killmail_id}/`;

  // Dedup + send
  const now = Date.now();
  if (recentNotifs.size > 500) {
    for (const [k, ts] of recentNotifs) { if (now - ts > DEDUP_TTL_MS) recentNotifs.delete(k); }
  }

  for (const { chat_id } of watchers) {
    const key = `${chat_id}:${kill.killmail_id}`;
    if (recentNotifs.has(key)) continue;
    recentNotifs.set(key, now);
    try { streamSender!(chat_id, text); } catch { /* */ }
  }

  console.log(`${LOG} kill ${kill.killmail_id} in ${systemName} → ${watchers.length} chats`);
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
