/**
 * Market snapshot loader -- rebuilds the local market_orders table by walking
 * every k-space trade region's public ESI order book directly:
 *
 *   GET /markets/{region_id}/orders/?order_type=all&page=N   (x-pages header)
 *
 * No third-party dump, no bulk file: pages are fetched one at a time through
 * the shared ESI retry/backoff helpers (fetchEsiWithRetry, throttleIfNeeded),
 * validated row by row, inserted in bounded batches (default 2000; measured
 * peak RSS ~135 MB — 20k rows/batch spiked to 306 MB on the 2 GB VM) and
 * released. A page is never retained after its batch flushes, and nothing is
 * written to esi_cache (The Forge alone would be a ~97 MB string there).
 *
 * Two-tier freshness: regions whose last sweep needed >= majorMinPages pages
 * refetch on the major interval, the rest on the minor one (intervals via env,
 * see config.marketSnapshot). Regions not yet due are carried over from the
 * serving table into staging with one local INSERT SELECT, so every swap still
 * commits a complete New Eden book. Per-region freshness lives in
 * market_snapshot_regions; ESI's own 5-minute Expires is honored there — a
 * region is never refetched before its cache entry expired.
 *
 * Failure semantics: a region that fails mid-sweep falls back to its previous
 * rows (recorded in market_snapshot_regions.last_error, stays due next tick);
 * a region with no prior rows aborts the whole sweep. Any abort drops the
 * staging table and leaves the previous snapshot serving.
 *
 * The swap is atomic: DROP old + RENAME staging in one transaction. The three
 * indexes are built on the staging table beforehand under per-pass names
 * (SQLite cannot rename indexes and names are schema-global; DROP TABLE
 * carries a table's indexes away with it), so the swap holds no index rebuild
 * and the old table keeps its own indexes until the rename. Executed/cancelled
 * orders disappear with the old table instead of lingering as ghosts.
 *
 * ESI order rows carry no region_id (known — the walk is per region), no
 * constellation_id (dropped: no consumers, no column) and no station_id.
 * station_id is derived after the load in one indexed pass: a location_id
 * present in sde_stations is an NPC station, anything else (player structures)
 * stays NULL — the same semantics the old EVE Ref dump had.
 *
 * Manual run: npx tsx src/eve/market-snapshot-loader.ts
 */

import { pathToFileURL } from 'node:url';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import {
  buildEsiUrl,
  buildPublicEsiHeaders,
  fetchEsiWithRetry,
  throttleIfNeeded,
  type EsiExecutionGuard,
} from './esi-client.js';
import { parseHeaderInt } from './http.js';

/**
 * Data-quality failures (the ESI payload itself looks corrupt) abort the whole
 * sweep: per-region fallback would ride out an upstream format change forever,
 * silently serving older and older rows. Transport/HTTP failures stay
 * region-level and fall back to the region's previous rows.
 */
class SnapshotDataQualityError extends Error {}

export const MARKET_ORDERS_TABLE = 'market_orders';
export const MARKET_ORDERS_STAGING_TABLE = 'market_orders_next';

export const DEFAULT_BATCH_SIZE = 2_000;
export const DEFAULT_MIN_ROWS = 1_000_000;
export const DEFAULT_MAX_MALFORMED_ROWS = 100;
export const DEFAULT_MAJOR_MIN_PAGES = 100;
export const DEFAULT_MAJOR_INTERVAL_MINUTES = 30;
export const DEFAULT_MINOR_INTERVAL_MINUTES = 360;

/** Provenance marker recorded into market_snapshot_state.snapshot_url. */
const SNAPSHOT_SOURCE = 'esi:/markets/{region_id}/orders';

const STAGING_DDL = `
CREATE TABLE ${MARKET_ORDERS_STAGING_TABLE} (
  order_id      INTEGER PRIMARY KEY,
  type_id       INTEGER NOT NULL,
  region_id     INTEGER NOT NULL,
  system_id     INTEGER NOT NULL,
  station_id    INTEGER,
  location_id   INTEGER NOT NULL,
  is_buy_order  INTEGER NOT NULL,
  price         REAL    NOT NULL,
  volume_remain INTEGER NOT NULL,
  volume_total  INTEGER NOT NULL,
  min_volume    INTEGER NOT NULL,
  duration      INTEGER NOT NULL,
  range         TEXT    NOT NULL,
  issued        TEXT    NOT NULL
)`;

const INSERT_SQL = `
INSERT INTO ${MARKET_ORDERS_STAGING_TABLE} (
  order_id, type_id, region_id, system_id, station_id, location_id,
  is_buy_order, price, volume_remain, volume_total, min_volume, duration,
  range, issued
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// ---------------------------------------------------------------------------
// ESI page fetch (production fetcher; tests inject a stub)
// ---------------------------------------------------------------------------

export type EsiMarketOrdersPage = {
  /** Raw JSON body; validated row by row by the loader. */
  orders: unknown;
  /** x-pages header (>= 1). */
  pages: number;
  /** Raw Expires header, stored per region to honor ESI's cache window. */
  expires: string | null;
  /** Raw Last-Modified header; a change mid-region means the book shifted. */
  lastModified: string | null;
};

export type MarketOrdersPageFetcher = (regionId: number, page: number) => Promise<EsiMarketOrdersPage>;

/**
 * Direct pager for /markets/{region_id}/orders/ outside callEsiOperation: the
 * generic path buffers all pages in memory and caches the concatenated JSON,
 * both unaffordable at whole-market scale. Retries, backoff, timeouts,
 * user-agent and error-limit throttling are the shared esi-client helpers.
 */
export function createEsiOrdersPageFetcher(guard: EsiExecutionGuard = {}): MarketOrdersPageFetcher {
  return async (regionId, page) => {
    const url = buildEsiUrl(config.esi.baseUrl, `/markets/${regionId}/orders/`);
    url.searchParams.set('order_type', 'all');
    url.searchParams.set('page', String(page));
    const result = await fetchEsiWithRetry(url, 'GET', buildPublicEsiHeaders(), null, guard);
    if (!result.ok) {
      throw new Error(
        `ESI orders page ${page} for region ${regionId} failed: HTTP ${result.result.status} ${result.result.error}`,
      );
    }
    const response = result.value;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new Error(
        `ESI orders page ${page} for region ${regionId} returned invalid JSON: ${(err as Error).message}`,
      );
    }
    const pageResult: EsiMarketOrdersPage = {
      orders: payload,
      pages: Math.max(1, Math.floor(parseHeaderInt(response.headers, 'x-pages') ?? 1)),
      expires: response.headers.get('expires'),
      lastModified: response.headers.get('last-modified'),
    };
    // Sleeps only when ESI's rate/error budget is nearly exhausted.
    await throttleIfNeeded(response.headers);
    return pageResult;
  };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export type SnapshotRegion = {
  region_id: number;
  name: string;
};

export type LoadMarketSnapshotOptions = {
  /** k-space trade regions to cover (loadTradeRegions from market-wide-summary). */
  regions: SnapshotRegion[];
  fetchPage: MarketOrdersPageFetcher;
  batchSize?: number;
  /** Sanity floor for the row count; the real book carries ~1.6M rows. */
  minRows?: number;
  maxMalformedRows?: number;
  /** Tier threshold: regions with at least this many pages refresh faster. */
  majorMinPages?: number;
  majorIntervalMinutes?: number;
  minorIntervalMinutes?: number;
  /** Clock override for tests. */
  now?: Date;
};

export type LoadMarketSnapshotResult = {
  /** false when no region was due — a cheap no-op tick, tables untouched. */
  swept: boolean;
  rowsLoaded: number;
  malformedRows: number;
  regionsFetched: number;
  regionsCarriedOver: number;
  regionErrors: Array<{ regionId: number; error: string }>;
};

type RegionFetchRecord = {
  regionId: number;
  pages: number;
  rowsLoaded: number;
  expiresAt: string | null;
};

export async function loadMarketSnapshotFromEsi(
  db: Db,
  options: LoadMarketSnapshotOptions,
): Promise<LoadMarketSnapshotResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const minRows = options.minRows ?? DEFAULT_MIN_ROWS;
  const maxMalformed = options.maxMalformedRows ?? DEFAULT_MAX_MALFORMED_ROWS;
  const majorMinPages = options.majorMinPages ?? DEFAULT_MAJOR_MIN_PAGES;
  const majorMs = (options.majorIntervalMinutes ?? DEFAULT_MAJOR_INTERVAL_MINUTES) * 60_000;
  const minorMs = (options.minorIntervalMinutes ?? DEFAULT_MINOR_INTERVAL_MINUTES) * 60_000;
  const now = options.now ?? new Date();

  const states = readRegionStates(db);
  const dueSet = new Set(
    options.regions
      .filter((region) => isRegionDue(states.get(region.region_id), now, { majorMinPages, majorMs, minorMs }))
      .map((region) => region.region_id),
  );
  if (dueSet.size === 0) {
    return { swept: false, rowsLoaded: 0, malformedRows: 0, regionsFetched: 0, regionsCarriedOver: 0, regionErrors: [] };
  }

  resetStagingTable(db);
  const insert = db.prepare(INSERT_SQL);
  const insertBatch = db.transaction((rows: unknown[][]) => {
    for (const row of rows) insert.run(...row);
  });
  const carryOverRegion = db.prepare(
    `INSERT INTO ${MARKET_ORDERS_STAGING_TABLE} SELECT * FROM ${MARKET_ORDERS_TABLE} WHERE region_id = ?`,
  );
  const dropRegionRows = db.prepare(`DELETE FROM ${MARKET_ORDERS_STAGING_TABLE} WHERE region_id = ?`);

  let rowsLoaded = 0;
  let malformedRows = 0;
  let regionsFetched = 0;
  let regionsCarriedOver = 0;
  const regionErrors: Array<{ regionId: number; error: string }> = [];
  // Region state is written only after the swap commits; a sweep that aborts
  // must not leave freshness records pointing at data that never went live.
  const fetchRecords: RegionFetchRecord[] = [];
  // Effective freshness of every region in the swapped book: fetched regions
  // are fresh as of `now`, carried-over ones keep their stored fetched_at.
  // The snapshot's honest age is the oldest of these (computed after commit).
  const effectiveFetchedAt = new Map<number, string | null>();
  const nowIso = now.toISOString();

  const fetchRegion = async (region: SnapshotRegion): Promise<RegionFetchRecord> => {
    let regionRows = 0;
    let batch: unknown[][] = [];
    let totalPages = 1;
    let firstLastModified: string | null = null;
    let expiresAt: string | null = null;

    for (let page = 1; page <= totalPages; page += 1) {
      const result = await options.fetchPage(region.region_id, page);
      // Re-read x-pages on every page: the book can grow/shrink at a cache
      // boundary, and the drift should resize the walk, not 404 it.
      totalPages = Math.max(1, Math.floor(result.pages));
      if (page === 1) {
        firstLastModified = result.lastModified;
        expiresAt = toIsoTimestamp(result.expires);
      } else if (firstLastModified && result.lastModified && result.lastModified !== firstLastModified) {
        throw new Error(`order book changed mid-sweep (last-modified ${firstLastModified} -> ${result.lastModified})`);
      }
      if (!Array.isArray(result.orders)) {
        throw new Error(`page ${page}: orders payload is not an array`);
      }
      for (const entry of result.orders) {
        const row = parseOrderRow(entry, region.region_id);
        if (row === null) {
          malformedRows += 1;
          if (malformedRows > maxMalformed) {
            throw new SnapshotDataQualityError(`Too many malformed rows (> ${maxMalformed}); aborting snapshot load`);
          }
          continue;
        }
        batch.push(row);
        if (batch.length >= batchSize) {
          insertBatch(batch);
          regionRows += batch.length;
          batch = [];
        }
      }
    }
    if (batch.length > 0) {
      insertBatch(batch);
      regionRows += batch.length;
    }
    return { regionId: region.region_id, pages: totalPages, rowsLoaded: regionRows, expiresAt };
  };

  try {
    for (const region of options.regions) {
      if (!dueSet.has(region.region_id)) {
        const carried = carryOverRegion.run(region.region_id).changes;
        const expected = states.get(region.region_id)?.rows_loaded ?? 0;
        if (carried > 0 || expected === 0) {
          rowsLoaded += carried;
          regionsCarriedOver += 1;
          effectiveFetchedAt.set(region.region_id, states.get(region.region_id)?.fetched_at ?? null);
          continue;
        }
        // Freshness state promised rows the serving table no longer has;
        // fall through and refetch the region now.
      }
      try {
        const record = await fetchRegion(region);
        fetchRecords.push(record);
        rowsLoaded += record.rowsLoaded;
        regionsFetched += 1;
        effectiveFetchedAt.set(region.region_id, nowIso);
      } catch (err) {
        if (err instanceof SnapshotDataQualityError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        dropRegionRows.run(region.region_id);
        const carried = carryOverRegion.run(region.region_id).changes;
        if (carried === 0) {
          throw new Error(`region ${region.region_id} (${region.name}) failed with no prior rows to keep: ${message}`);
        }
        rowsLoaded += carried;
        regionsCarriedOver += 1;
        regionErrors.push({ regionId: region.region_id, error: message });
        effectiveFetchedAt.set(region.region_id, states.get(region.region_id)?.fetched_at ?? null);
      }
    }
    if (rowsLoaded < minRows) {
      throw new Error(`Snapshot row count ${rowsLoaded} below the sanity floor ${minRows}; refusing to swap`);
    }
    deriveStationIds(db);
    await buildStagingIndexes(db);
    swapStagingIntoPlace(db);
  } catch (err) {
    dropStagingTable(db);
    throw err;
  }

  const recordRegionStates = db.transaction(() => {
    for (const record of fetchRecords) {
      recordRegionFetched(db, record, now);
    }
    for (const failure of regionErrors) {
      recordRegionError(db, failure.regionId, failure.error);
    }
  });
  recordRegionStates();

  // The swapped book mixes rows of different ages: freshly fetched regions,
  // carried-over regions on their tier interval, warm regions that failed
  // mid-sweep. The snapshot's honest age is the OLDEST region's — recording
  // the tick time here would report a half-day-old tail as freshly loaded.
  let oldestFetchedAt: string | null = null;
  for (const fetchedAt of effectiveFetchedAt.values()) {
    if (fetchedAt === null) {
      // A region of unknown age ages the whole book as unknown.
      oldestFetchedAt = null;
      break;
    }
    if (oldestFetchedAt === null || fetchedAt < oldestFetchedAt) oldestFetchedAt = fetchedAt;
  }

  // Partial failures stay visible: a committed sweep must not wipe last_error
  // and report "fresh, no errors" while some regions kept their old rows.
  const partialError = regionErrors.length > 0
    ? `Partial sweep: ${regionErrors.length} region(s) kept previous rows: ${
      regionErrors.map((failure) => `${failure.regionId}: ${failure.error}`).join('; ')
    }`
    : null;
  recordSnapshotLoaded(db, {
    url: SNAPSHOT_SOURCE,
    etag: null,
    snapshotTime: oldestFetchedAt,
    rowsLoaded,
    lastError: partialError,
  });
  return { swept: true, rowsLoaded, malformedRows, regionsFetched, regionsCarriedOver, regionErrors };
}

/**
 * ESI market order row: duration, is_buy_order, issued, location_id,
 * min_volume, order_id, price, range, system_id, type_id, volume_remain,
 * volume_total. region_id comes from the walk itself; station_id is left NULL
 * here and derived from the SDE in one pass before the swap.
 */
function parseOrderRow(entry: unknown, regionId: number): unknown[] | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;

  const orderId = safeInteger(record.order_id);
  const typeId = safeInteger(record.type_id);
  const systemId = safeInteger(record.system_id);
  const locationId = safeInteger(record.location_id);
  const duration = safeInteger(record.duration);
  const minVolume = safeInteger(record.min_volume);
  const volumeRemain = safeInteger(record.volume_remain);
  const volumeTotal = safeInteger(record.volume_total);
  const price = typeof record.price === 'number' && Number.isFinite(record.price) ? record.price : null;
  const isBuyOrder = record.is_buy_order === true ? 1 : record.is_buy_order === false ? 0 : null;
  const range = typeof record.range === 'string' && record.range ? record.range : null;
  const issued = typeof record.issued === 'string' && record.issued ? record.issued : null;

  if (orderId === null || typeId === null || systemId === null || locationId === null
    || duration === null || minVolume === null || volumeRemain === null || volumeTotal === null
    || price === null || price < 0 || isBuyOrder === null || range === null || issued === null) {
    return null;
  }

  return [
    orderId, typeId, regionId, systemId, null, locationId,
    isBuyOrder, price, volumeRemain, volumeTotal, minVolume, duration,
    range, issued,
  ];
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function toIsoTimestamp(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A location_id that resolves in sde_stations is an NPC station; player
 * structures (>= 1e12 ids) and anything unknown stay NULL. One indexed pass
 * over the staging table instead of a per-row lookup.
 */
function deriveStationIds(db: Db): void {
  db.exec(`
    UPDATE ${MARKET_ORDERS_STAGING_TABLE}
    SET station_id = location_id
    WHERE location_id IN (SELECT station_id FROM sde_stations)
  `);
}

function resetStagingTable(db: Db): void {
  db.exec(`DROP TABLE IF EXISTS ${MARKET_ORDERS_STAGING_TABLE}`);
  db.exec(STAGING_DDL);
}

function dropStagingTable(db: Db): void {
  db.exec(`DROP TABLE IF EXISTS ${MARKET_ORDERS_STAGING_TABLE}`);
}

// The three serving indexes. Names get a per-pass suffix: index names are
// schema-global and SQLite has no ALTER INDEX RENAME, so canonical names could
// not be created on the staging table while the old table still held them.
// DROP TABLE carries a table's indexes away with it, so per-pass names never
// collide across sweeps and the swap stays a pure DROP + RENAME.
const STAGING_INDEXES: Array<{ base: string; columns: string }> = [
  { base: 'idx_market_orders_type', columns: 'type_id' },
  { base: 'idx_market_orders_type_region', columns: 'type_id, region_id, is_buy_order, price' },
  { base: 'idx_market_orders_region', columns: 'region_id' },
];

let indexPassCounter = 0;

/**
 * Build the indexes on the filled staging table, one statement at a time with
 * an event-loop yield between them. Measured on 1.6M rows (see
 * .agent/tasks/market-snapshot-20260727/REVIEW-FIXES-RESULT.md): bulk insert +
 * rebuild here costs ~2.3s total while maintaining the indexes during the
 * insert costs ~38s — ~17x more CPU, rejected. Each statement is a synchronous
 * ~0.3-0.5s better-sqlite3 call, so splitting them with yields keeps the
 * process responsive between builds instead of one multi-second stall; the
 * old table keeps serving (and the swap itself stays sub-millisecond).
 */
async function buildStagingIndexes(db: Db): Promise<void> {
  indexPassCounter += 1;
  const suffix = `${Date.now().toString(36)}_${indexPassCounter.toString(36)}`;
  for (const [i, { base, columns }] of STAGING_INDEXES.entries()) {
    if (i > 0) await new Promise((resolve) => { setImmediate(resolve); });
    db.exec(`CREATE INDEX ${base}_${suffix} ON ${MARKET_ORDERS_STAGING_TABLE}(${columns})`);
  }
}

function swapStagingIntoPlace(db: Db): void {
  const swap = db.transaction(() => {
    // The old table's indexes go away with its DROP; the staging table's
    // per-pass-named indexes carry through the RENAME. Nothing to rebuild.
    db.exec(`DROP TABLE ${MARKET_ORDERS_TABLE}`);
    db.exec(`ALTER TABLE ${MARKET_ORDERS_STAGING_TABLE} RENAME TO ${MARKET_ORDERS_TABLE}`);
  });
  swap();
}

// ---------------------------------------------------------------------------
// Per-region freshness (two-tier schedule)
// ---------------------------------------------------------------------------

export type MarketSnapshotRegionRow = {
  region_id: number;
  pages: number | null;
  rows_loaded: number | null;
  fetched_at: string | null;
  expires_at: string | null;
  last_error: string | null;
};

function readRegionStates(db: Db): Map<number, MarketSnapshotRegionRow> {
  const rows = db.prepare(`
    SELECT region_id, pages, rows_loaded, fetched_at, expires_at, last_error
    FROM market_snapshot_regions
  `).all() as MarketSnapshotRegionRow[];
  return new Map(rows.map((row) => [row.region_id, row]));
}

export function getMarketSnapshotRegionStates(db: Db): MarketSnapshotRegionRow[] {
  return [...readRegionStates(db).values()].sort((a, b) => a.region_id - b.region_id);
}

function isRegionDue(
  state: MarketSnapshotRegionRow | undefined,
  now: Date,
  opts: { majorMinPages: number; majorMs: number; minorMs: number },
): boolean {
  if (!state?.fetched_at) return true;
  const fetchedAtMs = Date.parse(state.fetched_at);
  if (!Number.isFinite(fetchedAtMs)) return true;
  const intervalMs = (state.pages ?? 0) >= opts.majorMinPages ? opts.majorMs : opts.minorMs;
  let notBeforeMs = fetchedAtMs + intervalMs;
  // ESI caches the order book for 5 minutes; never refetch inside that window.
  const expiresMs = state.expires_at ? Date.parse(state.expires_at) : NaN;
  if (Number.isFinite(expiresMs)) {
    notBeforeMs = Math.max(notBeforeMs, expiresMs);
  }
  return now.getTime() >= notBeforeMs;
}

function recordRegionFetched(db: Db, record: RegionFetchRecord, now: Date): void {
  db.prepare(`
    INSERT INTO market_snapshot_regions (region_id, pages, rows_loaded, fetched_at, expires_at, last_error)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(region_id) DO UPDATE SET
      pages = excluded.pages,
      rows_loaded = excluded.rows_loaded,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at,
      last_error = NULL
  `).run(record.regionId, record.pages, record.rowsLoaded, now.toISOString(), record.expiresAt);
}

function recordRegionError(db: Db, regionId: number, message: string): void {
  db.prepare(`
    INSERT INTO market_snapshot_regions (region_id, last_error)
    VALUES (?, ?)
    ON CONFLICT(region_id) DO UPDATE SET last_error = excluded.last_error
  `).run(regionId, message.slice(0, 500));
}

// ---------------------------------------------------------------------------
// Snapshot state (singleton row, pattern of eve_kill_feed_state)
// ---------------------------------------------------------------------------

export type MarketSnapshotStateRow = {
  status: string;
  snapshot_url: string | null;
  snapshot_etag: string | null;
  snapshot_time: string | null;
  rows_loaded: number | null;
  loaded_at: string | null;
  last_error: string | null;
  last_attempt_at: string | null;
};

export function getMarketSnapshotState(db: Db): MarketSnapshotStateRow | null {
  const row = db.prepare(`
    SELECT status, snapshot_url, snapshot_etag, snapshot_time, rows_loaded,
           loaded_at, last_error, last_attempt_at
    FROM market_snapshot_state WHERE feed_key = 'global'
  `).get() as MarketSnapshotStateRow | undefined;
  return row ?? null;
}

export function recordSnapshotLoaded(
  db: Db,
  info: {
    url: string | null;
    etag: string | null;
    snapshotTime: string | null;
    rowsLoaded: number;
    /** Partial-sweep failures stay visible instead of being wiped by a commit. */
    lastError?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO market_snapshot_state (
      feed_key, status, snapshot_url, snapshot_etag, snapshot_time,
      rows_loaded, loaded_at, last_error, last_attempt_at
    ) VALUES ('global', 'idle', ?, ?, ?, ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT(feed_key) DO UPDATE SET
      status = 'idle',
      snapshot_url = excluded.snapshot_url,
      snapshot_etag = excluded.snapshot_etag,
      snapshot_time = excluded.snapshot_time,
      rows_loaded = excluded.rows_loaded,
      loaded_at = excluded.loaded_at,
      last_error = excluded.last_error,
      last_attempt_at = excluded.last_attempt_at
  `).run(info.url, info.etag, info.snapshotTime, info.rowsLoaded, info.lastError?.slice(0, 500) ?? null);
}

export function recordSnapshotError(db: Db, message: string): void {
  db.prepare(`
    INSERT INTO market_snapshot_state (feed_key, status, last_error, last_attempt_at)
    VALUES ('global', 'error', ?, datetime('now'))
    ON CONFLICT(feed_key) DO UPDATE SET
      status = 'error',
      last_error = excluded.last_error,
      last_attempt_at = excluded.last_attempt_at
  `).run(message.slice(0, 500));
}

export type MarketSnapshotRegionMeta = {
  region_id: number;
  fetched_at: string | null;
  age_minutes: number | null;
  stale: boolean;
  last_error: string | null;
};

export type MarketSnapshotMeta = {
  loaded: boolean;
  status: string;
  snapshot_time: string | null;
  age_minutes: number | null;
  stale: boolean;
  rows_loaded: number | null;
  last_error: string | null;
  regions: MarketSnapshotRegionMeta[];
};

function ageMinutesOf(iso: string | null, nowMs: number): number | null {
  const parsed = iso !== null ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed)
    ? Math.max(0, Math.round((nowMs - parsed) / 60_000))
    : null;
}

/**
 * Freshness view attached to every market-snapshot tool response so the agent
 * physically cannot answer without seeing the data age. snapshot_time is the
 * OLDEST region's fetched_at in the serving book — the swapped table mixes
 * rows of different ages (tier intervals, mid-sweep failures), so the tick
 * time would lie. Per-region ages ride along so the agent can cite the exact
 * region's age instead of the book-wide worst case.
 */
export function getMarketSnapshotMeta(db: Db, staleMinutes: number, now: Date = new Date()): MarketSnapshotMeta {
  const state = getMarketSnapshotState(db);
  const hasRows = db.prepare('SELECT 1 FROM market_orders LIMIT 1').get() !== undefined;
  const nowMs = now.getTime();
  const snapshotTime = state?.snapshot_time ?? null;
  const ageMinutes = ageMinutesOf(snapshotTime, nowMs);
  return {
    loaded: hasRows,
    status: state?.status ?? 'idle',
    snapshot_time: snapshotTime,
    age_minutes: ageMinutes,
    // Without a timestamp the age is unknown; treat it as stale rather than fresh.
    stale: ageMinutes === null ? true : ageMinutes > staleMinutes,
    rows_loaded: state?.rows_loaded ?? null,
    last_error: state?.last_error ?? null,
    regions: getMarketSnapshotRegionStates(db).map((row) => {
      const regionAge = ageMinutesOf(row.fetched_at, nowMs);
      return {
        region_id: row.region_id,
        fetched_at: row.fetched_at,
        age_minutes: regionAge,
        stale: regionAge === null ? true : regionAge > staleMinutes,
        last_error: row.last_error,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Manual CLI entry: npx tsx src/eve/market-snapshot-loader.ts
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { initDb } = await import('../db/sqlite.js');
  const { runMigrations } = await import('../db/migrations.js');
  const { loadTradeRegions } = await import('./market-wide-summary.js');

  const db = initDb(config.db.path);
  runMigrations(db);
  try {
    const regions = loadTradeRegions(db);
    if (regions.length === 0) {
      throw new Error('Local SDE has no stargate geography; cannot determine k-space trade regions.');
    }
    console.log(`[market-snapshot] Sweeping ${regions.length} trade regions from ESI...`);
    const startedAt = Date.now();
    const result = await loadMarketSnapshotFromEsi(db, {
      regions,
      fetchPage: createEsiOrdersPageFetcher(),
      batchSize: config.marketSnapshot.batchSize,
      majorMinPages: config.marketSnapshot.majorMinPages,
      majorIntervalMinutes: config.marketSnapshot.majorIntervalMinutes,
      minorIntervalMinutes: config.marketSnapshot.minorIntervalMinutes,
    });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[market-snapshot] swept=${result.swept} rows=${result.rowsLoaded} in ${seconds}s `
      + `(fetched ${result.regionsFetched} regions, carried over ${result.regionsCarriedOver}, `
      + `${result.malformedRows} malformed skipped, ${result.regionErrors.length} region errors)`,
    );
  } finally {
    db.close();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((err) => {
    console.error('[market-snapshot] Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
