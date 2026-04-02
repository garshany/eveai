/**
 * zKillboard R2Z2 — official real-time kill stream.
 * WebSocket deprecated, RedisQ sunset May 2026, R2Z2 is the replacement.
 *
 * Protocol (per https://github.com/zKillboard/zKillboard/wiki/API-(R2Z2)):
 *   GET /ephemeral/sequence.json → current sequence
 *   GET /ephemeral/{seq}.json → killmail data (ESI + zkb)
 *   On 200: sleep 100ms, seq++
 *   On 404: sleep 6000ms minimum (no new kills yet)
 *   Rate limit: 20 req/s, User-Agent required
 *
 * Filters locally against kill_watches DB.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';

const LOG = '[zkb-r2z2]';
const BASE = 'https://r2z2.zkillboard.com/ephemeral';
const DELAY_NEXT_MS = 100;      // 100ms between successful fetches (10 req/s)
const DELAY_EMPTY_MS = 6_000;   // 6s on 404 per docs
const MAX_CATCH_UP = 50;        // max kills per poll cycle before yielding
const MAX_KILL_AGE_MS = 10 * 60 * 1000;
const DEDUP_TTL_MS = 120_000;

type NotifySender = (chatId: number, text: string) => void;

type R2Z2Kill = {
  killmail_id: number;
  hash?: string;
  sequence_id?: number;
  esi?: {
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

let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let db: Db | null = null;
let send: NotifySender | null = null;
let running = false;
let killsProcessed = 0;

const recentNotifs = new Map<string, number>();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startZkbWs(dbInstance: Db, sender: NotifySender): Promise<void> {
  db = dbInstance;
  send = sender;
  running = true;

  // Get starting sequence
  try {
    const res = await fetch(`${BASE}/sequence.json`, {
      headers: { 'User-Agent': config.zkill.userAgent },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { sequence: number };
      seq = data.sequence;
    }
  } catch (err) {
    console.error(`${LOG} failed to get sequence:`, (err as Error).message);
  }

  let watchCount = 0;
  try {
    watchCount = (dbInstance.prepare('SELECT COUNT(DISTINCT topic) as c FROM kill_watches').get() as { c: number }).c;
  } catch { /* table may not exist yet */ }
  console.log(`${LOG} started at seq=${seq}, ${watchCount} watched topics`);

  schedule(DELAY_NEXT_MS);
}

export function stopZkbWs(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  console.log(`${LOG} stopped (processed ${killsProcessed} kills)`);
}

// No-op — R2Z2 is global stream, no per-topic subscription
export function subscribeTopics(_topics: string[]): void { /* */ }
export function unsubscribeTopics(_topics: string[]): void { /* */ }

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

function schedule(delay: number): void {
  if (!running) return;
  timer = setTimeout(() => {
    poll().catch((err) => {
      console.error(`${LOG} poll error (will retry):`, (err as Error).message);
      schedule(DELAY_EMPTY_MS);
    });
  }, delay);
}

async function poll(): Promise<void> {
  if (!running || !db || !send) return;

  let fetched = 0;

  while (fetched < MAX_CATCH_UP) {
    const nextSeq = seq + 1;
    let kill: R2Z2Kill | null = null;

    try {
      const res = await fetch(`${BASE}/${nextSeq}.json`, {
        headers: { 'User-Agent': config.zkill.userAgent },
        signal: AbortSignal.timeout(8000),
      });

      if (res.status === 404) {
        if (fetched === 0) console.log(`${LOG} waiting for seq=${nextSeq} (404)`);
        schedule(DELAY_EMPTY_MS);
        return;
      }

      if (!res.ok) {
        console.warn(`${LOG} seq=${nextSeq} status=${res.status}, backing off`);
        schedule(res.status === 429 ? 10_000 : DELAY_EMPTY_MS);
        return;
      }

      kill = await res.json() as R2Z2Kill;
    } catch (err) {
      console.error(`${LOG} fetch seq=${nextSeq} error:`, (err as Error).message);
      schedule(DELAY_EMPTY_MS);
      return;
    }

    seq = nextSeq;
    fetched++;
    killsProcessed++;

    // Log progress periodically
    if (killsProcessed === 1 || killsProcessed % 100 === 0) {
      console.log(`${LOG} processed ${killsProcessed} kills, seq=${seq}`);
    }

    // Skip NPC
    if (kill.zkb?.npc) continue;

    // Match against watches (protected — DB errors must not crash the poller)
    try {
      matchKill(db, kill);
    } catch (err) {
      console.error(`${LOG} matchKill error kill=${kill.killmail_id}:`, (err as Error).message);
    }

    // 100ms between requests per docs
    await sleep(DELAY_NEXT_MS);
  }

  // Yielded after MAX_CATCH_UP — continue immediately
  schedule(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Match + notify
// ---------------------------------------------------------------------------

function matchKill(database: Db, kill: R2Z2Kill): void {
  const esi = kill.esi;
  if (!esi) return;

  // Skip old
  if (esi.killmail_time) {
    const age = Date.now() - new Date(esi.killmail_time).getTime();
    if (age > MAX_KILL_AGE_MS || age < -60_000) return;
  }

  const topics: string[] = [];
  if (esi.solar_system_id) topics.push(`system.${esi.solar_system_id}`);
  if (esi.victim?.character_id) topics.push(`victim.${esi.victim.character_id}`);
  for (const atk of esi.attackers ?? []) {
    if (atk.character_id) topics.push(`attacker.${atk.character_id}`);
  }
  if (topics.length === 0) return;

  const placeholders = topics.map(() => '?').join(',');
  const watchers = database.prepare(
    `SELECT DISTINCT chat_id FROM kill_watches WHERE topic IN (${placeholders})`,
  ).all(...topics) as Array<{ chat_id: number }>;

  if (watchers.length === 0) return;

  // Format
  const value = kill.zkb?.totalValue ? Math.round(kill.zkb.totalValue / 1_000_000) : 0;
  const shipName = resolveType(database, esi.victim?.ship_type_id ?? null) ?? '?';
  const systemName = resolveSystem(database, esi.solar_system_id ?? 0);
  const soloTag = kill.zkb?.solo ? ' [SOLO]' : '';
  const text = `🔴 Kill in ${systemName}${soloTag}: ${shipName} (${value}M ISK)\nhttps://zkillboard.com/kill/${kill.killmail_id}/`;

  // Dedup
  const now = Date.now();
  if (recentNotifs.size > 500) {
    for (const [k, ts] of recentNotifs) { if (now - ts > DEDUP_TTL_MS) recentNotifs.delete(k); }
  }

  for (const { chat_id } of watchers) {
    const key = `${chat_id}:${kill.killmail_id}`;
    if (recentNotifs.has(key)) continue;
    recentNotifs.set(key, now);
    try { send!(chat_id, text); } catch { /* */ }
  }

  console.log(`${LOG} kill ${kill.killmail_id} in ${systemName} → ${watchers.length} chats`);
}

// ---------------------------------------------------------------------------
// SDE
// ---------------------------------------------------------------------------

const typeCache = new Map<number, string | null>();
function resolveType(database: Db, typeId: number | null): string | null {
  if (!typeId) return null;
  if (typeCache.has(typeId)) return typeCache.get(typeId)!;
  const row = database.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  const name = row?.name ?? null;
  typeCache.set(typeId, name);
  return name;
}

function resolveSystem(database: Db, systemId: number): string {
  const row = database.prepare('SELECT name FROM sde_systems WHERE system_id = ?').get(systemId) as { name: string } | undefined;
  return row?.name ?? `System ${systemId}`;
}
