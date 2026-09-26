/**
 * Perimeter live kill index.
 *
 * The global EVE-KILL feed poller already runs for kill watches. Perimeter
 * subscribes to it and keeps one rolling table of every killmail in New Eden,
 * shared by every user.
 *
 * That inversion is the point: without it, "what is happening in the 400
 * systems around me" costs dozens of outbound requests on every refresh, per
 * viewer, and can only ever be as fresh as the slowest of them. With it, the
 * same question is one indexed local query, the cost is paid once for everyone,
 * and the data is as fresh as the feed — seconds, against the hour that ESI's
 * aggregate endpoints offer.
 *
 * The table is bounded on both axes: rows older than the retention window are
 * swept, and a hard row cap trims the oldest survivors if the feed ever runs
 * hotter than expected.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { getEveKillFeedRuntimeStatus, subscribeEveKillFeed } from '../eve-kill/feed-poll.js';
import { searchKillmails } from '../eve-kill/client.js';
import type { NormalizedKillmail } from '../eve-kill/types.js';
import { nearestGate } from '../eve/map-graph.js';
import { hourOfWeekFor } from './system-metrics.js';
import { estimateKillValue } from './kill-value.js';

export type IndexedKill = {
  killmailId: number;
  systemId: number;
  regionId: number | null;
  killmailTime: string | null;
  killmailTimeMs: number;
  totalValue: number;
  attackerCount: number;
  isNpc: boolean;
  isSolo: boolean;
  victimShipTypeId: number | null;
  victimShipName: string | null;
  victimShipGroupName: string | null;
  victimCharacterId: number | null;
  victimCharacterName: string | null;
  victimCorporationName: string | null;
  finalBlowCharacterId: number | null;
  finalBlowCharacterName: string | null;
  finalBlowShipTypeId: number | null;
  finalBlowShipName: string | null;
  position: { x: number; y: number; z: number } | null;
  /** Stargate this kill happened on, or null when it happened elsewhere. */
  gateId: number | null;
};

export type SystemKillRollup = {
  systemId: number;
  kills15m: number;
  kills1h: number;
  /**
   * Kills over the last `killsWindowHours`. That window is 24 h only when the
   * index actually retains 24 h (MAP_KILL_INDEX_RETENTION_HOURS ≥ 24); with the
   * default 3 h retention it is 3 h. It used to be labelled `kills24h` while
   * holding at most the retention window, and gate kills (kept for days) made
   * it a mix of both.
   */
  killsWindow: number;
  killsWindowHours: number;
  pvpKills1h: number;
  npcKills1h: number;
  valueDestroyed1h: number;
  soloKills1h: number;
  /** Age of the freshest kill in minutes, or null when the window is empty. */
  lastKillMinutesAgo: number | null;
  lastKillAtMs: number | null;
};

export type KillIndexListener = (kill: IndexedKill) => void;

const WINDOW_15M_MS = 15 * 60_000;
const WINDOW_1H_MS = 60 * 60_000;
/** The longest "recent kills" window the index can answer honestly. */
const MAX_KILLS_WINDOW_HOURS = 24;

/** Hours covered by `SystemKillRollup.killsWindow`: min(24, retention). */
export function killsWindowHours(): number {
  return Math.max(1, Math.min(MAX_KILLS_WINDOW_HOURS, config.map.killIndexRetentionHours));
}
/** SQLite's default parameter ceiling is 999; stay well under it when chunking. */
const SQL_CHUNK = 400;

const listeners = new Set<KillIndexListener>();
let unsubscribeFeed: (() => void) | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lastSweepAt: string | null = null;
let ingested = 0;

/** Notified for every killmail written, so a live map can push it immediately. */
export function onIndexedKill(listener: KillIndexListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getKillIndexStatus(db: Db): {
  running: boolean;
  rows: number;
  ingested: number;
  oldestAtMs: number | null;
  newestAtMs: number | null;
  lastSweepAt: string | null;
} {
  const row = db.prepare(`
    SELECT COUNT(*) AS rows, MIN(killmail_time_ms) AS oldest, MAX(killmail_time_ms) AS newest
    FROM map_kill_events
  `).get() as { rows: number; oldest: number | null; newest: number | null };
  return {
    running: unsubscribeFeed !== null,
    rows: row.rows,
    ingested,
    oldestAtMs: row.oldest,
    newestAtMs: row.newest,
    lastSweepAt,
  };
}

/**
 * The feed polls every second and backs off to at most thirty; a last success
 * older than this means the index is no longer live, whatever it last held.
 */
const FEED_STALE_AFTER_MS = 90_000;

export type KillFeedFreshness = {
  status: 'live' | 'cached' | 'unavailable';
  retrievedAt: string | null;
  error: string | null;
};

/**
 * How live the kill layer really is. The bubble used to label it 'live'
 * unconditionally, so a dead or stalled feed left the radar silently quiet —
 * which reads as "all clear", the most dangerous thing a radar can say wrongly.
 */
export function getKillFeedFreshness(now = Date.now()): KillFeedFreshness {
  const feed = getEveKillFeedRuntimeStatus();
  if (unsubscribeFeed === null || !feed.running) {
    return {
      status: 'unavailable',
      retrievedAt: feed.lastSuccessAt,
      error: 'Live kill feed is not running; kill activity is not being updated.',
    };
  }
  // The index is a non-blocking observer: it stays live while watch delivery
  // holds the durable cursor, so its freshness is the last page it was fed,
  // not the last fully acknowledged poll.
  const lastFedAt = newestIso(feed.lastObservedAt ?? null, feed.lastSuccessAt);
  const lastSuccessMs = lastFedAt ? Date.parse(lastFedAt) : Number.NaN;
  if (!Number.isFinite(lastSuccessMs)) {
    return { status: 'cached', retrievedAt: null, error: feed.lastError ?? 'Live kill feed has not answered yet.' };
  }
  if (now - lastSuccessMs > FEED_STALE_AFTER_MS) {
    return {
      status: 'cached',
      retrievedAt: lastFedAt,
      error: `Live kill feed is stale${feed.lastError ? `: ${feed.lastError}` : ''}.`,
    };
  }
  return { status: 'live', retrievedAt: lastFedAt, error: null };
}

function newestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Attach to the running feed. Safe to call twice — the second call is a no-op
 * rather than a second subscription, so a restarted poller cannot double-write.
 */
export function startMapKillIndex(db: Db): () => void {
  if (unsubscribeFeed) return stopMapKillIndex;

  // Observer mode: the index is fed every page before (and independently of)
  // the blocking watch delivery, so a Telegram/Discord outage that holds the
  // durable feed cursor does not freeze the map. Redelivery after a restart is
  // absorbed by the killmail_id primary key.
  unsubscribeFeed = subscribeEveKillFeed((event) => {
    try {
      recordKillmail(db, event.killmail);
    } catch (error) {
      console.warn('[map-kill-index] ingest failed: %s', (error as Error).message);
    }
  }, { mode: 'observer' });

  sweepKillIndex(db);
  sweepTimer = setInterval(() => {
    try {
      sweepKillIndex(db);
    } catch (error) {
      console.warn('[map-kill-index] sweep failed: %s', (error as Error).message);
    }
  }, 5 * 60_000);
  sweepTimer.unref?.();

  return stopMapKillIndex;
}

export function stopMapKillIndex(): void {
  unsubscribeFeed?.();
  unsubscribeFeed = null;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** Test seam: drops listeners and timers without touching the table. */
export function resetMapKillIndexForTests(): void {
  stopMapKillIndex();
  listeners.clear();
  ingested = 0;
  lastSweepAt = null;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const INSERT_SQL = `
  INSERT INTO map_kill_events (
    killmail_id, system_id, region_id, killmail_time, killmail_time_ms, received_at_ms,
    total_value, attacker_count, is_npc, is_solo,
    victim_ship_type_id, victim_ship_name, victim_ship_group_name,
    victim_character_id, victim_character_name, victim_corporation_name,
    final_blow_character_id, final_blow_character_name,
    final_blow_ship_type_id, final_blow_ship_name,
    position_json, source, gate_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(killmail_id) DO NOTHING
`;

/**
 * Write one killmail. At-least-once delivery is assumed: the feed can redeliver
 * after a restart, so the primary key plus DO NOTHING is the dedup, and
 * listeners fire only for rows that were actually new.
 */
export function recordKillmail(
  db: Db,
  killmail: NormalizedKillmail,
  source: 'feed' | 'backfill' = 'feed',
  now = Date.now(),
): IndexedKill | null {
  const systemId = killmail.solarSystemId;
  if (!isPositiveInt(killmail.killmailId) || !isPositiveInt(systemId)) return null;

  const parsedTime = killmail.killmailTime ? Date.parse(killmail.killmailTime) : Number.NaN;
  // A killmail without a usable timestamp cannot be windowed, and treating it
  // as "now" would make stale backfill look live. Fall back only for the feed,
  // whose events are by definition current.
  const killmailTimeMs = Number.isFinite(parsedTime)
    ? parsedTime
    : source === 'feed' ? now : Number.NaN;
  if (!Number.isFinite(killmailTimeMs)) return null;

  const finalBlow = killmail.attackers.find((attacker) => attacker.finalBlow)
    ?? killmail.attackers[0]
    ?? null;

  // Attribution happens here, not at read time, so a gate kill can be kept past
  // the short rolling retention and still be found once its row is the only
  // evidence left that this gate gets camped.
  const gateId = killmail.position && !killmail.isNpc
    ? safeNearestGate(db, systemId, killmail.position)
    : null;

  // ESI-shaped feed killmails carry no value; estimate it locally so value
  // rules and ISK-destroyed layers work on live kills, not only on backfill.
  const totalValue = killmail.totalValue ?? estimateKillValue(db, killmail, now) ?? 0;

  const result = db.prepare(INSERT_SQL).run(
    killmail.killmailId,
    systemId,
    killmail.regionId ?? null,
    killmail.killmailTime ?? null,
    killmailTimeMs,
    now,
    totalValue,
    killmail.attackerCount ?? 0,
    killmail.isNpc ? 1 : 0,
    killmail.isSolo ? 1 : 0,
    killmail.victim.shipTypeId ?? null,
    killmail.victim.shipName ?? null,
    killmail.victim.shipGroupName ?? null,
    killmail.victim.characterId ?? null,
    killmail.victim.characterName ?? null,
    killmail.victim.corporationName ?? null,
    finalBlow?.characterId ?? null,
    finalBlow?.characterName ?? null,
    finalBlow?.shipTypeId ?? null,
    finalBlow?.shipName ?? null,
    killmail.position ? JSON.stringify(killmail.position) : null,
    source,
    gateId,
  );

  if (result.changes === 0) return null;
  ingested += 1;

  const indexed: IndexedKill = {
    killmailId: killmail.killmailId,
    systemId,
    regionId: killmail.regionId ?? null,
    killmailTime: killmail.killmailTime ?? null,
    killmailTimeMs,
    totalValue,
    attackerCount: killmail.attackerCount ?? 0,
    isNpc: Boolean(killmail.isNpc),
    isSolo: Boolean(killmail.isSolo),
    victimShipTypeId: killmail.victim.shipTypeId ?? null,
    victimShipName: killmail.victim.shipName ?? null,
    victimShipGroupName: killmail.victim.shipGroupName ?? null,
    victimCharacterId: killmail.victim.characterId ?? null,
    victimCharacterName: killmail.victim.characterName ?? null,
    victimCorporationName: killmail.victim.corporationName ?? null,
    finalBlowCharacterId: finalBlow?.characterId ?? null,
    finalBlowCharacterName: finalBlow?.characterName ?? null,
    finalBlowShipTypeId: finalBlow?.shipTypeId ?? null,
    finalBlowShipName: finalBlow?.shipName ?? null,
    position: killmail.position ?? null,
    gateId,
  };

  if (gateId !== null) recordGateCamp(db, gateId, systemId, killmailTimeMs, finalBlow);

  // Only the live feed drives push notifications; a backfill of two-hour-old
  // history must not flash on someone's map as if it just happened.
  if (source === 'feed') {
    for (const listener of listeners) {
      try {
        listener(indexed);
      } catch (error) {
        console.warn('[map-kill-index] listener failed: %s', (error as Error).message);
      }
    }
  }
  return indexed;
}

/**
 * Nearest-gate lookup that can never take the feed down with it: a graph that
 * failed to build leaves the kill unattributed rather than dropping it.
 */
function safeNearestGate(
  db: Db,
  systemId: number,
  position: { x: number; y: number; z: number },
): number | null {
  try {
    return nearestGate(db, systemId, position)?.gateId ?? null;
  } catch {
    return null;
  }
}

/**
 * Camp memory. Two rollups that outlive the kill rows they came from: how often
 * this gate sees kills at this hour of the week, and who keeps making them.
 * This is what turns "two kills on a gate right now" into "this gate is camped
 * on weekday evenings, usually by these pilots".
 */
function recordGateCamp(
  db: Db,
  gateId: number,
  systemId: number,
  killmailTimeMs: number,
  finalBlow: { characterId?: number; characterName?: string; corporationName?: string } | null,
): void {
  db.prepare(`
    INSERT INTO map_gate_camp_history (gate_id, system_id, hour_of_week, kills, last_kill_ms)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(gate_id, hour_of_week) DO UPDATE SET
      kills = kills + 1,
      last_kill_ms = MAX(last_kill_ms, excluded.last_kill_ms)
  `).run(gateId, systemId, hourOfWeekFor(killmailTimeMs), killmailTimeMs);

  if (finalBlow?.characterId) {
    db.prepare(`
      INSERT INTO map_gate_campers (gate_id, character_id, character_name, corporation_name, kills, last_kill_ms)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(gate_id, character_id) DO UPDATE SET
        kills = kills + 1,
        character_name = COALESCE(excluded.character_name, character_name),
        corporation_name = COALESCE(excluded.corporation_name, corporation_name),
        last_kill_ms = MAX(last_kill_ms, excluded.last_kill_ms)
    `).run(
      gateId,
      finalBlow.characterId,
      finalBlow.characterName ?? null,
      finalBlow.corporationName ?? null,
      killmailTimeMs,
    );
  }
}

/** Age retention first, then the row cap. Both are cheap indexed deletes. */
export function sweepKillIndex(db: Db, now = Date.now()): { byAge: number; byCap: number } {
  const cutoff = now - config.map.killIndexRetentionHours * 3_600_000;
  // Gate kills are the evidence behind camp history and are kept far longer:
  // the whole point of accumulating is that "this gate is camped at 19:00"
  // cannot be answered from a three-hour window.
  const gateCutoff = now - config.map.gateKillRetentionDays * 24 * 3_600_000;
  const byAge = db.prepare(`
    DELETE FROM map_kill_events
    WHERE (gate_id IS NULL AND killmail_time_ms < ?)
       OR (gate_id IS NOT NULL AND killmail_time_ms < ?)
  `).run(cutoff, gateCutoff).changes;

  let byCap = 0;
  const rows = (db.prepare('SELECT COUNT(*) AS n FROM map_kill_events').get() as { n: number }).n;
  if (rows > config.map.killIndexMaxRows) {
    byCap = db.prepare(`
      DELETE FROM map_kill_events WHERE killmail_id IN (
        SELECT killmail_id FROM map_kill_events
        -- Ordinary kills go first: the long-lived gate kills are the oldest
        -- rows by construction, and evicting purely by age would wipe camp
        -- history before a single three-hour-old non-gate row.
        ORDER BY (gate_id IS NOT NULL) ASC, killmail_time_ms ASC
        LIMIT ?
      )
    `).run(rows - config.map.killIndexMaxRows).changes;
  }

  db.prepare('DELETE FROM map_kill_backfill WHERE backfilled_at_ms < ?')
    .run(now - config.map.killBackfillTtlSeconds * 1000);

  lastSweepAt = new Date(now).toISOString();
  return { byAge, byCap };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * One row per requested system, including systems with no activity — a caller
 * drawing a map needs the zeroes as much as the hits.
 */
export function getSystemKillRollups(
  db: Db,
  systemIds: number[],
  now = Date.now(),
): Map<number, SystemKillRollup> {
  const result = new Map<number, SystemKillRollup>();
  for (const systemId of systemIds) {
    result.set(systemId, emptyRollup(systemId));
  }
  if (systemIds.length === 0) return result;

  const windowHours = killsWindowHours();
  const since = now - windowHours * 3_600_000;
  for (const chunk of chunked(systemIds, SQL_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT
        system_id,
        SUM(CASE WHEN killmail_time_ms >= ? THEN 1 ELSE 0 END) AS kills_15m,
        SUM(CASE WHEN killmail_time_ms >= ? THEN 1 ELSE 0 END) AS kills_1h,
        COUNT(*) AS kills_window,
        SUM(CASE WHEN killmail_time_ms >= ? AND is_npc = 0 THEN 1 ELSE 0 END) AS pvp_1h,
        SUM(CASE WHEN killmail_time_ms >= ? AND is_npc = 1 THEN 1 ELSE 0 END) AS npc_1h,
        SUM(CASE WHEN killmail_time_ms >= ? AND is_solo = 1 THEN 1 ELSE 0 END) AS solo_1h,
        SUM(CASE WHEN killmail_time_ms >= ? THEN total_value ELSE 0 END) AS value_1h,
        MAX(killmail_time_ms) AS last_ms
      FROM map_kill_events
      WHERE killmail_time_ms >= ? AND system_id IN (${placeholders})
      GROUP BY system_id
    `).all(
      now - WINDOW_15M_MS,
      now - WINDOW_1H_MS,
      now - WINDOW_1H_MS,
      now - WINDOW_1H_MS,
      now - WINDOW_1H_MS,
      now - WINDOW_1H_MS,
      since,
      ...chunk,
    ) as Array<{
      system_id: number;
      kills_15m: number;
      kills_1h: number;
      kills_window: number;
      pvp_1h: number;
      npc_1h: number;
      solo_1h: number;
      value_1h: number;
      last_ms: number | null;
    }>;

    for (const row of rows) {
      result.set(row.system_id, {
        systemId: row.system_id,
        kills15m: row.kills_15m ?? 0,
        kills1h: row.kills_1h ?? 0,
        killsWindow: row.kills_window ?? 0,
        killsWindowHours: windowHours,
        pvpKills1h: row.pvp_1h ?? 0,
        npcKills1h: row.npc_1h ?? 0,
        valueDestroyed1h: row.value_1h ?? 0,
        soloKills1h: row.solo_1h ?? 0,
        lastKillMinutesAgo: row.last_ms === null ? null : Math.max(0, (now - row.last_ms) / 60_000),
        lastKillAtMs: row.last_ms,
      });
    }
  }
  return result;
}

export function getRecentKills(
  db: Db,
  systemId: number,
  options: { limit?: number; sinceMs?: number } = {},
): IndexedKill[] {
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const since = options.sinceMs ?? 0;
  const rows = db.prepare(`
    SELECT * FROM map_kill_events
    WHERE system_id = ? AND killmail_time_ms >= ?
    ORDER BY killmail_time_ms DESC
    LIMIT ?
  `).all(systemId, since, limit) as KillRow[];
  return rows.map(toIndexedKill);
}

/** Kills across a set of systems, newest first — the bubble's activity feed. */
export function getRecentKillsForSystems(
  db: Db,
  systemIds: number[],
  options: { limit?: number; sinceMs?: number } = {},
): IndexedKill[] {
  if (systemIds.length === 0) return [];
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const since = options.sinceMs ?? 0;
  const collected: IndexedKill[] = [];
  for (const chunk of chunked(systemIds, SQL_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT * FROM map_kill_events
      WHERE system_id IN (${placeholders}) AND killmail_time_ms >= ?
      ORDER BY killmail_time_ms DESC
      LIMIT ?
    `).all(...chunk, since, limit) as KillRow[];
    for (const row of rows) collected.push(toIndexedKill(row));
  }
  collected.sort((a, b) => b.killmailTimeMs - a.killmailTimeMs);
  return collected.slice(0, limit);
}

/**
 * Attacker characters seen killing in these systems inside the window, with a
 * per-system count. Feeds both repeat-attacker scoring and pursuit detection.
 */
export function getAttackerActivity(
  db: Db,
  systemIds: number[],
  sinceMs: number,
): Map<number, Array<{ characterId: number; name: string | null; kills: number }>> {
  const result = new Map<number, Array<{ characterId: number; name: string | null; kills: number }>>();
  if (systemIds.length === 0) return result;
  for (const chunk of chunked(systemIds, SQL_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT system_id, final_blow_character_id AS character_id,
             final_blow_character_name AS name, COUNT(*) AS kills
      FROM map_kill_events
      WHERE system_id IN (${placeholders})
        AND killmail_time_ms >= ?
        AND is_npc = 0
        AND final_blow_character_id IS NOT NULL
      GROUP BY system_id, final_blow_character_id
      ORDER BY kills DESC
    `).all(...chunk, sinceMs) as Array<{
      system_id: number; character_id: number; name: string | null; kills: number;
    }>;
    for (const row of rows) {
      const list = result.get(row.system_id);
      const entry = { characterId: row.character_id, name: row.name, kills: row.kills };
      if (list) list.push(entry);
      else result.set(row.system_id, [entry]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cold-start backfill
// ---------------------------------------------------------------------------

/**
 * After a restart the index is empty and every map would open blank. Pull the
 * retention window for systems nobody has pulled recently.
 *
 * Bounded three ways: only systems missing from `map_kill_backfill`, at most
 * `killBackfillMaxSystems` of them per call, and the request budget of the
 * EVE-KILL client itself. The bookkeeping row is written even when the request
 * fails, so a failing upstream cannot turn into a retry storm — the next
 * attempt waits for the TTL like everyone else.
 */
export async function backfillSystems(
  db: Db,
  systemIds: number[],
  now = Date.now(),
): Promise<{ requested: number; ingested: number; error: string | null }> {
  const cutoff = now - config.map.killBackfillTtlSeconds * 1000;
  const pending: number[] = [];
  const seen = db.prepare(
    'SELECT backfilled_at_ms FROM map_kill_backfill WHERE system_id = ?',
  );
  for (const systemId of systemIds) {
    const row = seen.get(systemId) as { backfilled_at_ms: number } | undefined;
    if (row && row.backfilled_at_ms >= cutoff) continue;
    pending.push(systemId);
    if (pending.length >= config.map.killBackfillMaxSystems) break;
  }
  if (pending.length === 0) return { requested: 0, ingested: 0, error: null };

  const mark = db.prepare(`
    INSERT INTO map_kill_backfill (system_id, backfilled_at_ms) VALUES (?, ?)
    ON CONFLICT(system_id) DO UPDATE SET backfilled_at_ms = excluded.backfilled_at_ms
  `);
  const markAll = db.transaction((ids: number[]) => {
    for (const id of ids) mark.run(id, now);
  });
  markAll(pending);

  const from = new Date(now - config.map.killIndexRetentionHours * 3_600_000).toISOString();
  const result = await searchKillmails(
    db,
    { from, to: new Date(now).toISOString(), system_ids: pending },
    { limit: 2000, maxRequests: 40 },
  );
  if (!result.ok) {
    return { requested: pending.length, ingested: 0, error: result.error };
  }

  let count = 0;
  const write = db.transaction((kills: NormalizedKillmail[]) => {
    for (const kill of kills) {
      if (recordKillmail(db, kill, 'backfill', now)) count += 1;
    }
  });
  write(result.data.kills);
  return { requested: pending.length, ingested: count, error: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type KillRow = {
  killmail_id: number;
  system_id: number;
  region_id: number | null;
  killmail_time: string | null;
  killmail_time_ms: number;
  total_value: number;
  attacker_count: number;
  is_npc: number;
  is_solo: number;
  victim_ship_type_id: number | null;
  victim_ship_name: string | null;
  victim_ship_group_name: string | null;
  victim_character_id: number | null;
  victim_character_name: string | null;
  victim_corporation_name: string | null;
  final_blow_character_id: number | null;
  final_blow_character_name: string | null;
  final_blow_ship_type_id: number | null;
  final_blow_ship_name: string | null;
  position_json: string | null;
  gate_id: number | null;
};

function toIndexedKill(row: KillRow): IndexedKill {
  let position: { x: number; y: number; z: number } | null = null;
  if (row.position_json) {
    try {
      const parsed: unknown = JSON.parse(row.position_json);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.x === 'number' && typeof record.y === 'number' && typeof record.z === 'number') {
          position = { x: record.x, y: record.y, z: record.z };
        }
      }
    } catch {
      position = null;
    }
  }
  return {
    killmailId: row.killmail_id,
    systemId: row.system_id,
    regionId: row.region_id,
    killmailTime: row.killmail_time,
    killmailTimeMs: row.killmail_time_ms,
    totalValue: row.total_value,
    attackerCount: row.attacker_count,
    isNpc: row.is_npc === 1,
    isSolo: row.is_solo === 1,
    victimShipTypeId: row.victim_ship_type_id,
    victimShipName: row.victim_ship_name,
    victimShipGroupName: row.victim_ship_group_name,
    victimCharacterId: row.victim_character_id,
    victimCharacterName: row.victim_character_name,
    victimCorporationName: row.victim_corporation_name,
    finalBlowCharacterId: row.final_blow_character_id,
    finalBlowCharacterName: row.final_blow_character_name,
    finalBlowShipTypeId: row.final_blow_ship_type_id,
    finalBlowShipName: row.final_blow_ship_name,
    position,
    gateId: row.gate_id,
  };
}

export function emptyRollup(systemId: number): SystemKillRollup {
  return {
    systemId,
    kills15m: 0,
    kills1h: 0,
    killsWindow: 0,
    killsWindowHours: killsWindowHours(),
    pvpKills1h: 0,
    npcKills1h: 0,
    valueDestroyed1h: 0,
    soloKills1h: 0,
    lastKillMinutesAgo: null,
    lastKillAtMs: null,
  };
}

/**
 * Fills in names the feed did not carry.
 *
 * The EVE-KILL feed publishes ESI-shaped killmails: ids, no names. Stored as-is
 * they render as "неизвестный" for every victim and every attacker, which makes
 * the whole "кто кого убил" panel worthless. Ship names come from the local SDE
 * for free; character names need one bulk lookup, so callers resolve them only
 * for what they are about to show.
 */
export function resolveShipNames(db: Db, kills: IndexedKill[]): IndexedKill[] {
  const typeIds = new Set<number>();
  for (const kill of kills) {
    if (kill.victimShipName === null && kill.victimShipTypeId) typeIds.add(kill.victimShipTypeId);
    if (kill.finalBlowShipName === null && kill.finalBlowShipTypeId) typeIds.add(kill.finalBlowShipTypeId);
  }
  if (typeIds.size === 0) return kills;

  const names = new Map<number, string>();
  for (const chunk of chunked([...typeIds], SQL_CHUNK)) {
    const rows = db.prepare(
      `SELECT type_id, name FROM sde_types WHERE type_id IN (${chunk.map(() => '?').join(',')})`,
    ).all(...chunk) as Array<{ type_id: number; name: string }>;
    for (const row of rows) names.set(row.type_id, row.name);
  }

  return kills.map((kill) => ({
    ...kill,
    victimShipName: kill.victimShipName
      ?? (kill.victimShipTypeId === null ? null : names.get(kill.victimShipTypeId) ?? null),
    finalBlowShipName: kill.finalBlowShipName
      ?? (kill.finalBlowShipTypeId === null ? null : names.get(kill.finalBlowShipTypeId) ?? null),
  }));
}

/** Character ids on these kills whose names are still missing. */
export function missingCharacterIds(kills: IndexedKill[]): number[] {
  const ids = new Set<number>();
  for (const kill of kills) {
    if (kill.victimCharacterName === null && kill.victimCharacterId) ids.add(kill.victimCharacterId);
    if (kill.finalBlowCharacterName === null && kill.finalBlowCharacterId) ids.add(kill.finalBlowCharacterId);
  }
  return [...ids];
}

export function applyCharacterNames(kills: IndexedKill[], names: Map<number, string>): IndexedKill[] {
  if (names.size === 0) return kills;
  return kills.map((kill) => ({
    ...kill,
    victimCharacterName: kill.victimCharacterName
      ?? (kill.victimCharacterId === null ? null : names.get(kill.victimCharacterId) ?? null),
    finalBlowCharacterName: kill.finalBlowCharacterName
      ?? (kill.finalBlowCharacterId === null ? null : names.get(kill.finalBlowCharacterId) ?? null),
  }));
}

export type GateCampHistory = {
  gateId: number;
  systemId: number;
  destinationSystemId: number | null;
  totalKills: number;
  lastKillMs: number;
  /** Hours of the week ranked by kill count, worst first. */
  peakHours: Array<{ hourOfWeek: number; kills: number }>;
  campers: Array<{
    characterId: number;
    name: string | null;
    corporation: string | null;
    kills: number;
    lastKillMs: number;
  }>;
};

/**
 * Accumulated camp history for the gates of one system. Empty until enough time
 * has passed — this is memory, not a live reading, and it says so by returning
 * nothing rather than a confident guess from two data points.
 */
export function getGateCampHistory(db: Db, systemId: number, limit = 5): GateCampHistory[] {
  const gates = db.prepare(`
    SELECT h.gate_id, h.system_id, SUM(h.kills) AS total, MAX(h.last_kill_ms) AS last_ms,
           g.destination_system_id
    FROM map_gate_camp_history h
    LEFT JOIN map_gates g ON g.gate_id = h.gate_id
    WHERE h.system_id = ?
    GROUP BY h.gate_id
    ORDER BY total DESC
    LIMIT ?
  `).all(systemId, Math.max(1, Math.min(20, limit))) as Array<{
    gate_id: number; system_id: number; total: number; last_ms: number;
    destination_system_id: number | null;
  }>;

  const peakStatement = db.prepare(`
    SELECT hour_of_week, kills FROM map_gate_camp_history
    WHERE gate_id = ? ORDER BY kills DESC LIMIT 3
  `);
  const camperStatement = db.prepare(`
    SELECT character_id, character_name, corporation_name, kills, last_kill_ms
    FROM map_gate_campers WHERE gate_id = ? ORDER BY kills DESC LIMIT 5
  `);

  return gates.map((gate) => ({
    gateId: gate.gate_id,
    systemId: gate.system_id,
    destinationSystemId: gate.destination_system_id,
    totalKills: gate.total,
    lastKillMs: gate.last_ms,
    peakHours: (peakStatement.all(gate.gate_id) as Array<{ hour_of_week: number; kills: number }>)
      .map((row) => ({ hourOfWeek: row.hour_of_week, kills: row.kills })),
    campers: (camperStatement.all(gate.gate_id) as Array<{
      character_id: number; character_name: string | null;
      corporation_name: string | null; kills: number; last_kill_ms: number;
    }>).map((row) => ({
      characterId: row.character_id,
      name: row.character_name,
      corporation: row.corporation_name,
      kills: row.kills,
      lastKillMs: row.last_kill_ms,
    })),
  }));
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
