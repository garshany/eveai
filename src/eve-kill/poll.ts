/**
 * Kill watch poller — polls zKillboard for watched topics, enriches via ESI.
 * Self-contained, no dependency on EVE-KILL REST availability.
 *
 * Every POLL_INTERVAL_MS:
 *   1. For each watched topic, fetch zKB feed
 *   2. Compare killmail_ids with last_seen
 *   3. Enrich new kills with ESI names
 *   4. Send Telegram alerts
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';

const LOG = '[kill-poll]';
const POLL_INTERVAL_MS = 60_000;
const MAX_KILL_AGE_MS = 15 * 60 * 1000;

type NotifySender = (chatId: number, text: string) => void;

// ---------------------------------------------------------------------------
// zKB feed item
// ---------------------------------------------------------------------------

type ZkbFeedItem = {
  killmail_id: number;
  zkb?: {
    hash?: string;
    totalValue?: number;
    npc?: boolean;
    solo?: boolean;
  };
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const lastSeen = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollDb: Db | null = null;
let pollSender: NotifySender | null = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startKillPoller(db: Db, sender: NotifySender): void {
  pollDb = db;
  pollSender = sender;

  ensureLastSeenTable(db);
  const rows = db.prepare('SELECT topic, last_killmail_id FROM kill_watch_state').all() as Array<{ topic: string; last_killmail_id: number }>;
  for (const r of rows) lastSeen.set(r.topic, r.last_killmail_id);

  console.log(`${LOG} starting (interval=${POLL_INTERVAL_MS / 1000}s, ${lastSeen.size} saved states)`);

  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

export function stopKillPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log(`${LOG} stopped`);
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

async function pollOnce(): Promise<void> {
  if (!pollDb || !pollSender) return;

  const topics = pollDb.prepare('SELECT DISTINCT topic FROM kill_watches').all() as Array<{ topic: string }>;
  if (topics.length === 0) return;

  for (const { topic } of topics) {
    try {
      await pollTopic(pollDb, topic);
    } catch (err) {
      console.error(`${LOG} error ${topic}:`, (err as Error).message);
    }
  }
}

async function pollTopic(db: Db, topic: string): Promise<void> {
  const zkbPath = topicToZkbPath(topic);
  if (!zkbPath) return;

  // Fetch from zKillboard
  const feed = await fetchZkbFeed(zkbPath);
  if (feed.length === 0) return;

  const prev = lastSeen.get(topic) ?? 0;
  const isFirstPoll = prev === 0;

  if (isFirstPoll) {
    // First poll: seed last_seen, send the most recent kill as confirmation
    const maxId = Math.max(...feed.map((km) => km.killmail_id));
    lastSeen.set(topic, maxId);
    saveLastSeen(db, topic, maxId);

    // Send only the latest kill as "subscription active" confirmation
    const latest = feed.find((km) => km.killmail_id === maxId);
    if (latest) {
      const enriched = await enrichKills(db, [latest]);
      if (enriched.length > 0) {
        const chatIds = (db.prepare('SELECT DISTINCT chat_id FROM kill_watches WHERE topic = ?').all(topic) as Array<{ chat_id: number }>).map((r) => r.chat_id);
        for (const chatId of chatIds) {
          try { pollSender!(chatId, `✅ Watch active! Latest kill:\n${formatAlert(enriched[0])}`); } catch { /* */ }
        }
        console.log(`${LOG} ${topic}: seeded last_seen=${maxId}, sent confirmation`);
      }
    }
    return;
  }

  // Find new kills since last poll
  const newKills = feed.filter((km) => km.killmail_id > prev);
  if (newKills.length === 0) return;

  // Update last_seen
  const maxId = Math.max(...newKills.map((km) => km.killmail_id));
  lastSeen.set(topic, maxId);
  saveLastSeen(db, topic, maxId);

  // Enrich with ESI
  const enriched = await enrichKills(db, newKills);
  const fresh = enriched.filter((km) => {
    if (!km.time) return true;
    return Date.now() - new Date(km.time).getTime() < MAX_KILL_AGE_MS;
  });

  if (fresh.length === 0) return;

  // Find watchers
  const chatIds = (db.prepare('SELECT DISTINCT chat_id FROM kill_watches WHERE topic = ?').all(topic) as Array<{ chat_id: number }>).map((r) => r.chat_id);
  if (chatIds.length === 0) return;

  // Send alerts
  for (const km of fresh) {
    const text = formatAlert(km);
    for (const chatId of chatIds) {
      try {
        pollSender!(chatId, text);
      } catch { /* */ }
    }
  }

  console.log(`${LOG} ${topic}: ${fresh.length} new → ${chatIds.length} chats`);
}

// ---------------------------------------------------------------------------
// zKillboard fetch
// ---------------------------------------------------------------------------

async function fetchZkbFeed(path: string): Promise<ZkbFeedItem[]> {
  const url = `${config.zkill.baseUrl}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': config.zkill.userAgent,
      },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((item: unknown): item is ZkbFeedItem =>
      !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).killmail_id === 'number',
    );
  } catch {
    return [];
  }
}

function topicToZkbPath(topic: string): string | null {
  const [type, idStr] = topic.split('.');
  const id = Number(idStr);
  if (!type || !Number.isFinite(id)) return null;

  switch (type) {
    case 'system':    return `kills/systemID/${id}/pastSeconds/3600/`;
    case 'region':    return `kills/regionID/${id}/pastSeconds/3600/`;
    case 'victim':    return `losses/characterID/${id}/`;
    case 'attacker':  return `kills/characterID/${id}/`;
    default:          return null;
  }
}

// ---------------------------------------------------------------------------
// ESI enrichment (names, ship, system)
// ---------------------------------------------------------------------------

type EnrichedKill = {
  killmail_id: number;
  time: string | null;
  system: string | null;
  sec: number | null;
  victim: string | null;
  victim_ship: string | null;
  attacker: string | null;
  value_m: number;
  npc: boolean;
  solo: boolean;
  url: string;
};

async function enrichKills(db: Db, items: ZkbFeedItem[]): Promise<EnrichedKill[]> {
  const results: EnrichedKill[] = [];

  for (const item of items.slice(0, 5)) {
    const hash = item.zkb?.hash;
    if (!hash) {
      results.push({
        killmail_id: item.killmail_id,
        time: null, system: null, sec: null, victim: null, victim_ship: null, attacker: null,
        value_m: Math.round((item.zkb?.totalValue ?? 0) / 1_000_000),
        npc: item.zkb?.npc ?? false, solo: item.zkb?.solo ?? false,
        url: `https://zkillboard.com/kill/${item.killmail_id}/`,
      });
      continue;
    }

    try {
      const r = await callEsiOperation<Record<string, unknown>>(
        db, 'get_killmails_killmail_id_killmail_hash',
        { killmail_id: item.killmail_id, killmail_hash: hash },
      );
      if (!r.ok || !r.data) {
        console.log(`${LOG} ESI enrich failed for ${item.killmail_id}: ${r.ok ? 'no data' : ('error' in r ? String(r.error) : 'unknown')}`);
        results.push(basicKill(item));
        continue;
      }

      const km = r.data;
      const victim = asRec(km.victim);
      const attackers = Array.isArray(km.attackers) ? km.attackers as Record<string, unknown>[] : [];
      const fb = attackers.find((a) => a.final_blow === true) ?? attackers[0] ?? {};

      const systemId = numOrNull(km.solar_system_id);
      const sysInfo = systemId ? resolveSystem(db, systemId) : null;

      // Batch resolve names
      const ids = new Set<number>();
      const vCharId = numOrNull(victim.character_id);
      const vCorpId = numOrNull(victim.corporation_id);
      const aCharId = numOrNull(fb.character_id);
      const aCorpId = numOrNull(fb.corporation_id);
      for (const id of [vCharId, vCorpId, aCharId, aCorpId]) {
        if (id) ids.add(id);
      }
      const names = await resolveNames(db, ids);

      results.push({
        killmail_id: item.killmail_id,
        time: typeof km.killmail_time === 'string' ? km.killmail_time : null,
        system: sysInfo?.name ?? null,
        sec: sysInfo?.sec ?? null,
        victim: names.get(vCharId ?? 0) ?? names.get(vCorpId ?? 0) ?? null,
        victim_ship: resolveType(db, numOrNull(victim.ship_type_id)),
        attacker: names.get(aCharId ?? 0) ?? names.get(aCorpId ?? 0) ?? null,
        value_m: Math.round((item.zkb?.totalValue ?? 0) / 1_000_000),
        npc: item.zkb?.npc ?? false,
        solo: item.zkb?.solo ?? false,
        url: `https://zkillboard.com/kill/${item.killmail_id}/`,
      });
    } catch {
      results.push(basicKill(item));
    }
  }

  return results;
}

function basicKill(item: ZkbFeedItem): EnrichedKill {
  return {
    killmail_id: item.killmail_id,
    time: null, system: null, sec: null, victim: null, victim_ship: null, attacker: null,
    value_m: Math.round((item.zkb?.totalValue ?? 0) / 1_000_000),
    npc: item.zkb?.npc ?? false, solo: item.zkb?.solo ?? false,
    url: `https://zkillboard.com/kill/${item.killmail_id}/`,
  };
}

// ---------------------------------------------------------------------------
// Alert formatting
// ---------------------------------------------------------------------------

function formatAlert(km: EnrichedKill): string {
  const victim = km.victim ?? '?';
  const ship = km.victim_ship ?? '?';
  const system = km.system ?? '?';
  const sec = km.sec != null ? ` (${km.sec.toFixed(1)})` : '';
  const npcTag = km.npc ? ' [NPC]' : '';
  const soloTag = km.solo ? ' [SOLO]' : '';
  return `🔴 ${victim} lost ${ship} in ${system}${sec}${npcTag}${soloTag}\n💰 ${km.value_m}M ISK | ${km.attacker ?? '?'}\n${km.url}`;
}

// ---------------------------------------------------------------------------
// SDE/ESI helpers
// ---------------------------------------------------------------------------

const typeCache = new Map<number, string | null>();
function resolveType(db: Db, typeId: number | null): string | null {
  if (typeId === null) return null;
  if (typeCache.has(typeId)) return typeCache.get(typeId)!;
  const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  const name = row?.name ?? null;
  typeCache.set(typeId, name);
  return name;
}

function resolveSystem(db: Db, systemId: number): { name: string; sec: number } | null {
  const row = db.prepare(
    "SELECT name, COALESCE(json_extract(data_json, '$.securityStatus'), json_extract(data_json, '$.security')) as sec FROM sde_systems WHERE system_id = ?",
  ).get(systemId) as { name: string; sec: number | null } | undefined;
  return row ? { name: row.name, sec: row.sec != null ? Math.round(row.sec * 10) / 10 : 0 } : null;
}

async function resolveNames(db: Db, ids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.size === 0) return map;
  try {
    const r = await callEsiOperation<Array<{ id: number; name: string }>>(
      db, 'post_universe_names', { ids: JSON.stringify([...ids].slice(0, 30)) },
    );
    if (r.ok && Array.isArray(r.data)) {
      for (const e of r.data) { if (e.id && e.name) map.set(e.id, e.name); }
    }
  } catch { /* */ }
  return map;
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

function ensureLastSeenTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kill_watch_state (
      topic TEXT PRIMARY KEY,
      last_killmail_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function saveLastSeen(db: Db, topic: string, killmailId: number): void {
  db.prepare(`
    INSERT INTO kill_watch_state (topic, last_killmail_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(topic) DO UPDATE SET
      last_killmail_id = excluded.last_killmail_id,
      updated_at = excluded.updated_at
  `).run(topic, killmailId);
}
