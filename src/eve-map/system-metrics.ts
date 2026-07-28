/**
 * Long-term accumulation for Perimeter.
 *
 * Two ESI endpoints each return the *whole cluster* in one response —
 * `/universe/system_jumps/` (traffic) and `/universe/system_kills/` (counts).
 * Two requests an hour therefore cover all of New Eden, which is why this is
 * cheap enough to just always run. Until now the map fetched both on every
 * bubble build and threw the numbers away.
 *
 * What is stored:
 *   • `map_system_hourly` — raw hourly buckets, pruned after a retention window.
 *   • `map_system_profile` — sums by hour of week, which outlive the raw rows.
 *     This is what answers "is 19:00 on a weekday busy or quiet here".
 *
 * The bucket key is the response's `Last-Modified`, not the wall clock: ESI
 * caches these for an hour, so a re-fetch inside the same hour must land on the
 * same bucket and change nothing. That makes the whole worker idempotent across
 * restarts, which matters because a restart is exactly when it re-polls.
 */

import { Cron } from 'croner';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';

export type HourlyRow = {
  systemId: number;
  shipJumps: number;
  shipKills: number;
  npcKills: number;
  podKills: number;
};

export type SystemProfileHour = {
  hourOfWeek: number;
  samples: number;
  avgShipJumps: number;
  avgShipKills: number;
  avgNpcKills: number;
};

/** Poll more often than hourly so a new bucket is picked up promptly; a poll
 *  inside the same hour is served from the ESI cache and writes nothing. */
const CRON_EXPRESSION = '7,22,37,52 * * * *';
const HOUR_MS = 3_600_000;
const WEEK_HOURS = 168;

let cronJob: Cron | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let lastTickAt: string | null = null;
let lastError: string | null = null;
let bucketsWritten = 0;

export function startSystemMetricsWorker(db: Db): void {
  if (!config.map.metricsHistoryEnabled) {
    console.log('[map-metrics] disabled (MAP_METRICS_HISTORY_ENABLED=false)');
    return;
  }
  if (cronJob) return;

  cronJob = new Cron(CRON_EXPRESSION, { protect: true }, async () => {
    await runTick(db);
  });

  // A restart should not wait up to fifteen minutes for the first sample.
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void runTick(db);
  }, 20_000);
  bootTimer.unref?.();

  console.log('[map-metrics] hourly system metrics accumulation started');
}

export function stopSystemMetricsWorker(): void {
  cronJob?.stop();
  cronJob = null;
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
}

export function getSystemMetricsStatus(db: Db): {
  running: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  bucketsWritten: number;
  hourlyRows: number;
  profileRows: number;
  oldestHourMs: number | null;
} {
  const hourly = db.prepare(
    'SELECT COUNT(*) AS rows, MIN(hour_start_ms) AS oldest FROM map_system_hourly',
  ).get() as { rows: number; oldest: number | null };
  const profile = db.prepare('SELECT COUNT(*) AS rows FROM map_system_profile')
    .get() as { rows: number };
  return {
    running: cronJob !== null,
    lastTickAt,
    lastError,
    bucketsWritten,
    hourlyRows: hourly.rows,
    profileRows: profile.rows,
    oldestHourMs: hourly.oldest,
  };
}

export function resetSystemMetricsForTests(): void {
  stopSystemMetricsWorker();
  lastTickAt = null;
  lastError = null;
  bucketsWritten = 0;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export async function runTick(db: Db, now = Date.now()): Promise<{
  written: number;
  hourStartMs: number | null;
  error: string | null;
}> {
  lastTickAt = new Date(now).toISOString();
  try {
    const [jumps, kills] = await Promise.all([
      fetchMetric(db, 'get_universe_system_jumps'),
      fetchMetric(db, 'get_universe_system_kills'),
    ]);

    // Each endpoint publishes on its own boundary, and during that window they
    // report different hours. Merging them under one bucket would permanently
    // fold, say, 11:00 traffic into the 10:00 profile — so each is written into
    // the bucket its own Last-Modified names. When they agree, which is almost
    // always, this is exactly one bucket.
    let written = 0;
    const buckets = new Set<number>();

    if (jumps.rows.length > 0) {
      const bucket = jumps.hourStartMs ?? truncateToHour(now);
      written += writeBucket(db, bucket, jumps.rows, 'jumps');
      buckets.add(bucket);
    }
    if (kills.rows.length > 0) {
      const bucket = kills.hourStartMs ?? truncateToHour(now);
      written += writeBucket(db, bucket, kills.rows, 'kills');
      buckets.add(bucket);
    }

    bucketsWritten += written;
    lastError = jumps.error ?? kills.error;
    pruneHourly(db, now);
    return { written, hourStartMs: buckets.size > 0 ? Math.max(...buckets) : null, error: lastError };
  } catch (error) {
    lastError = (error as Error).message;
    console.warn('[map-metrics] tick failed: %s', lastError);
    return { written: 0, hourStartMs: null, error: lastError };
  }
}

/**
 * Write one hourly bucket and fold the delta into the long-term profile.
 *
 * Delta rather than plain addition: the same bucket can be written more than
 * once (a restart, an extra poll, a late-publishing endpoint), and adding twice
 * would quietly inflate the profile that later gets presented as "how busy this
 * system usually is". Re-writing identical values is a no-op by construction.
 */
export function writeBucket(
  db: Db,
  hourStartMs: number,
  rows: HourlyRow[],
  /** Which endpoint produced these rows; each owns its own columns. */
  kind: 'jumps' | 'kills' | 'both' = 'both',
): number {
  // A system missing from the payload contributed a real zero for this hour and
  // must dilute its own average, so the hour is counted regardless of which
  // systems appeared in it.
  markHourSampled(db, hourStartMs, kind);
  const hourOfWeek = hourOfWeekFor(hourStartMs);
  const writesJumps = kind === 'jumps' || kind === 'both';
  const writesKills = kind === 'kills' || kind === 'both';
  const existing = db.prepare(
    'SELECT system_id, ship_jumps, ship_kills, npc_kills, pod_kills FROM map_system_hourly WHERE hour_start_ms = ?',
  );
  // Only the owning endpoint's columns are touched, so a jumps write cannot
  // zero the kills already recorded for the same hour, and vice versa.
  const upsertHourly = db.prepare(`
    INSERT INTO map_system_hourly (system_id, hour_start_ms, ship_jumps, ship_kills, npc_kills, pod_kills)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(system_id, hour_start_ms) DO UPDATE SET
      ship_jumps = CASE WHEN ? THEN excluded.ship_jumps ELSE ship_jumps END,
      ship_kills = CASE WHEN ? THEN excluded.ship_kills ELSE ship_kills END,
      npc_kills  = CASE WHEN ? THEN excluded.npc_kills  ELSE npc_kills  END,
      pod_kills  = CASE WHEN ? THEN excluded.pod_kills  ELSE pod_kills  END
  `);
  const upsertProfile = db.prepare(`
    INSERT INTO map_system_profile (
      system_id, hour_of_week, samples, sum_ship_jumps, sum_ship_kills, sum_npc_kills, sum_pod_kills
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(system_id, hour_of_week) DO UPDATE SET
      samples        = samples + excluded.samples,
      sum_ship_jumps = sum_ship_jumps + excluded.sum_ship_jumps,
      sum_ship_kills = sum_ship_kills + excluded.sum_ship_kills,
      sum_npc_kills  = sum_npc_kills + excluded.sum_npc_kills,
      sum_pod_kills  = sum_pod_kills + excluded.sum_pod_kills
  `);

  const write = db.transaction((batch: HourlyRow[]) => {
    const previous = new Map<number, HourlyRow>();
    for (const row of existing.all(hourStartMs) as Array<{
      system_id: number; ship_jumps: number; ship_kills: number; npc_kills: number; pod_kills: number;
    }>) {
      previous.set(row.system_id, {
        systemId: row.system_id,
        shipJumps: row.ship_jumps,
        shipKills: row.ship_kills,
        npcKills: row.npc_kills,
        podKills: row.pod_kills,
      });
    }

    let count = 0;
    for (const row of batch) {
      // Systems with nothing at all are the overwhelming majority; storing them
      // would multiply the table by six for no information.
      const carriesData = (writesJumps && row.shipJumps > 0)
        || (writesKills && (row.shipKills > 0 || row.npcKills > 0 || row.podKills > 0));
      if (!carriesData) continue;
      const before = previous.get(row.systemId);
      upsertHourly.run(
        row.systemId, hourStartMs,
        writesJumps ? row.shipJumps : 0,
        writesKills ? row.shipKills : 0,
        writesKills ? row.npcKills : 0,
        writesKills ? row.podKills : 0,
        writesJumps ? 1 : 0, writesKills ? 1 : 0, writesKills ? 1 : 0, writesKills ? 1 : 0,
      );
      upsertProfile.run(
        row.systemId,
        hourOfWeek,
        // The denominator is global now; per-system sample counts stay only as
        // a record of how often this system had anything at all.
        before ? 0 : 1,
        writesJumps ? row.shipJumps - (before?.shipJumps ?? 0) : 0,
        writesKills ? row.shipKills - (before?.shipKills ?? 0) : 0,
        writesKills ? row.npcKills - (before?.npcKills ?? 0) : 0,
        writesKills ? row.podKills - (before?.podKills ?? 0) : 0,
      );
      count += 1;
    }
    return count;
  });

  return write(rows);
}

/**
 * Records that this hour has been observed. Idempotent by primary key, so a
 * re-poll inside the same hour costs nothing and cannot inflate the denominator.
 */
function markHourSampled(db: Db, hourStartMs: number, kind: 'jumps' | 'kills' | 'both'): void {
  db.prepare(
    'INSERT OR IGNORE INTO map_sampled_hours (hour_start_ms, kind, hour_of_week) VALUES (?, ?, ?)',
  ).run(hourStartMs, kind, hourOfWeekFor(hourStartMs));
}

/** How many distinct hours of this weekday-hour have been observed. */
export function sampledHoursFor(db: Db, hourOfWeek: number): number {
  const row = db.prepare(
    'SELECT COUNT(DISTINCT hour_start_ms) AS n FROM map_sampled_hours WHERE hour_of_week = ?',
  ).get(hourOfWeek) as { n: number };
  return row.n;
}

export function pruneHourly(db: Db, now = Date.now()): number {
  const cutoff = now - config.map.metricsHourlyRetentionDays * 24 * HOUR_MS;
  return db.prepare('DELETE FROM map_system_hourly WHERE hour_start_ms < ?').run(cutoff).changes;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Typical traffic and kills for this system at this hour of the week. */
export function getSystemProfile(
  db: Db,
  systemId: number,
  hourOfWeek: number,
): SystemProfileHour | null {
  const row = db.prepare(`
    SELECT hour_of_week, samples, sum_ship_jumps, sum_ship_kills, sum_npc_kills
    FROM map_system_profile WHERE system_id = ? AND hour_of_week = ?
  `).get(systemId, hourOfWeek) as {
    hour_of_week: number; samples: number;
    sum_ship_jumps: number; sum_ship_kills: number; sum_npc_kills: number;
  } | undefined;
  if (!row) return null;
  // Divide by hours observed, not by hours this system happened to be busy.
  const denominator = Math.max(sampledHoursFor(db, hourOfWeek), row.samples);
  if (denominator === 0) return null;
  return {
    hourOfWeek: row.hour_of_week,
    samples: denominator,
    avgShipJumps: row.sum_ship_jumps / denominator,
    avgShipKills: row.sum_ship_kills / denominator,
    avgNpcKills: row.sum_npc_kills / denominator,
  };
}

/**
 * Deaths per thousand jumps, from the accumulated profile.
 *
 * This is the number that separates "three kills against a thousand jumps" from
 * "three kills against ten". Returns null rather than a made-up figure when
 * there is not enough traffic to divide by.
 */
export function mortalityPerThousandJumps(
  db: Db,
  systemId: number,
  hourOfWeek: number,
): number | null {
  const profile = getSystemProfile(db, systemId, hourOfWeek);
  if (!profile || profile.avgShipJumps < 1) return null;
  return (profile.avgShipKills / profile.avgShipJumps) * 1000;
}

/** UTC hour of the week, 0 = Sunday 00:00. EVE time is UTC, so this is EVE time. */
export function hourOfWeekFor(timeMs: number): number {
  const date = new Date(timeMs);
  return date.getUTCDay() * 24 + date.getUTCHours();
}

export function currentHourOfWeek(now = Date.now()): number {
  return hourOfWeekFor(now);
}

// ---------------------------------------------------------------------------
// ESI
// ---------------------------------------------------------------------------

async function fetchMetric(
  db: Db,
  operation: 'get_universe_system_jumps' | 'get_universe_system_kills',
): Promise<{ rows: HourlyRow[]; hourStartMs: number | null; error: string | null }> {
  const response = await callEsiOperation<unknown>(db, operation, {}, null);
  if (!response.ok || !Array.isArray(response.data)) {
    return {
      rows: [],
      hourStartMs: null,
      error: response.ok ? `${operation}: unexpected payload` : `${operation}: ${response.error}`,
    };
  }

  const rows: HourlyRow[] = [];
  for (const entry of response.data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.system_id !== 'number') continue;
    rows.push({
      systemId: record.system_id,
      shipJumps: numberOr(record.ship_jumps, 0),
      shipKills: numberOr(record.ship_kills, 0),
      npcKills: numberOr(record.npc_kills, 0),
      podKills: numberOr(record.pod_kills, 0),
    });
  }

  const lastModified = response.headers?.['last-modified'];
  const parsed = typeof lastModified === 'string' ? Date.parse(lastModified) : Number.NaN;
  return {
    rows,
    hourStartMs: Number.isFinite(parsed) ? truncateToHour(parsed) : null,
    error: null,
  };
}

function truncateToHour(timeMs: number): number {
  return Math.floor(timeMs / HOUR_MS) * HOUR_MS;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export const __testables = { truncateToHour, WEEK_HOURS };
