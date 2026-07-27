/**
 * Market snapshot loader -- rebuilds the local market_orders table by walking
 * every k-space trade region's public ESI order book directly:
 *
 *   GET /markets/{region_id}/orders/?order_type=all&page=N   (x-pages header)
 *
 * No third-party dump, no bulk file: page 1 of a region goes first (its
 * x-pages sizes the walk, its Last-Modified anchors the snapshot), the rest
 * of the pages run through a bounded pool (mapPool, pageConcurrency — default
 * 8) over the shared ESI retry/backoff helpers (fetchEsiWithRetry,
 * throttleIfNeeded). A large region must finish far inside ESI's 5-minute
 * cache window: a sequential walk of The Forge's ~410 pages outlives the
 * window, the book flips mid-walk, and a cold sweep could never commit. Rows
 * are validated page by page and inserted in bounded batches (default 2000;
 * measured peak RSS ~135 MB — 20k rows/batch spiked to 306 MB on the 2 GB VM)
 * straight from the page handler, so peak memory tracks pool size times one
 * page, never the region's page count. Nothing is written to esi_cache (The
 * Forge alone would be a ~97 MB string there).
 *
 * Two-tier freshness: regions whose last sweep needed >= majorMinPages pages
 * refetch on the major interval, the rest on the minor one (intervals via env,
 * see config.marketSnapshot). Regions not yet due are carried over from the
 * serving table into staging with one local INSERT SELECT, so every swap still
 * commits a complete New Eden book. Per-region freshness lives in
 * market_snapshot_regions; ESI's own 5-minute Expires is honored there — a
 * region is never refetched before its cache entry expired.
 *
 * Failure semantics: a mid-walk Last-Modified flip (ESI's routine 5-minute
 * cache rotation) triggers ONE re-walk of the region — cheap now that a walk
 * is seconds, and the re-walk lands inside a single snapshot; only a second
 * consecutive flip fails the region. A region that fails mid-sweep falls back
 * to its previous rows (recorded in market_snapshot_regions.last_error, stays
 * due next tick); a region with no prior rows aborts the whole sweep. Any
 * abort drops the staging table and leaves the previous snapshot serving.
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
import { acquireRuntimeLock, type RuntimeLock } from '../runtime/process-lock.js';
import {
  buildEsiUrl,
  buildPublicEsiHeaders,
  fetchEsiWithRetry,
  throttleIfNeeded,
  type EsiExecutionGuard,
} from './esi-client.js';
import { parseHeaderInt } from './http.js';
import { mapPool } from './market-wide-summary.js';

/**
 * Data-quality failures (the ESI payload itself looks corrupt) abort the whole
 * sweep: per-region fallback would ride out an upstream format change forever,
 * silently serving older and older rows. Transport/HTTP failures stay
 * region-level and fall back to the region's previous rows.
 */
class SnapshotDataQualityError extends Error {}

/**
 * A page disagreed with the walk's first page on Last-Modified: ESI's cached
 * book flipped to the next 5-minute snapshot mid-walk. Not fatal by itself —
 * fetchRegion re-walks the region once; only a SECOND consecutive flip fails
 * the region (SnapshotDataQualityError's transport-level sibling).
 */
class SnapshotBookDriftError extends Error {}

export const MARKET_ORDERS_TABLE = 'market_orders';
export const MARKET_ORDERS_STAGING_TABLE = 'market_orders_next';

export const DEFAULT_BATCH_SIZE = 2_000;
export const DEFAULT_MIN_ROWS = 1_000_000;
export const DEFAULT_MAX_MALFORMED_ROWS = 100;
export const DEFAULT_MAJOR_MIN_PAGES = 100;
export const DEFAULT_MAJOR_INTERVAL_MINUTES = 30;
export const DEFAULT_MINOR_INTERVAL_MINUTES = 360;
export const DEFAULT_PAGE_CONCURRENCY = 8;
/**
 * Sanity ceiling on x-pages growth mid-walk (The Forge is ~410 pages today).
 * A runaway x-pages would otherwise spin the pool forever on a corrupt or
 * hostile upstream.
 */
const MAX_REGION_PAGES = 1_000;
/** One initial walk plus one re-walk after a mid-walk cache flip. */
const MAX_REGION_WALK_ATTEMPTS = 2;

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
  /**
   * Page fan-out inside ONE region's walk (page 1 still goes first, alone, to
   * size the walk). 8 walks The Forge's ~410 pages in ~10-15 s — far inside
   * ESI's 5-minute cache window — while staying polite toward interactive ESI
   * calls, which share the same IP rate/error budget (this walker bypasses
   * the agent's ESI-leaf admission controller by design).
   */
  pageConcurrency?: number;
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
  const pageConcurrency = Math.max(1, Math.floor(options.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY));
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

  // One region's page walk, attempt-scoped. Page 1 goes first, alone: its
  // x-pages sizes the walk and its Last-Modified is the snapshot reference
  // every later page must agree with. The remaining pages run through a
  // bounded pool (mapPool, fail-fast). A page reporting MORE x-pages extends
  // the walk with another pooled pass (capped): with Last-Modified absent the
  // book can still grow mid-walk, and the growth should resize the walk, not
  // strand the extra pages.
  const walkRegion = async (region: SnapshotRegion): Promise<RegionFetchRecord> => {
    let regionRows = 0;
    let pending: unknown[][] = [];

    // Parsed rows flush into staging straight from the page handler, so a
    // page is never retained after its batch flushes: peak memory is bounded
    // by pool size times one page, not by the region's page count.
    const flush = (): void => {
      if (pending.length === 0) return;
      insertBatch(pending);
      regionRows += pending.length;
      pending = [];
    };
    const stageRows = (result: EsiMarketOrdersPage, page: number): void => {
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
        pending.push(row);
      }
      if (pending.length >= batchSize) flush();
    };
    const readPageCount = (value: number): number => {
      const pages = Math.max(1, Math.floor(value));
      if (pages > MAX_REGION_PAGES) {
        throw new SnapshotDataQualityError(
          `x-pages ${pages} exceeds the sanity cap ${MAX_REGION_PAGES}; aborting snapshot load`,
        );
      }
      return pages;
    };

    const first = await options.fetchPage(region.region_id, 1);
    const firstLastModified = first.lastModified;
    const expiresAt = toIsoTimestamp(first.expires);
    let totalPages = readPageCount(first.pages);
    stageRows(first, 1);

    const fetchAndStage = async (page: number): Promise<number> => {
      const result = await options.fetchPage(region.region_id, page);
      if (firstLastModified && result.lastModified && result.lastModified !== firstLastModified) {
        throw new SnapshotBookDriftError(
          `order book changed mid-sweep (last-modified ${firstLastModified} -> ${result.lastModified})`,
        );
      }
      stageRows(result, page);
      return readPageCount(result.pages);
    };

    let nextPage = 2;
    while (nextPage <= totalPages) {
      const pageNumbers: number[] = [];
      for (let page = nextPage; page <= totalPages; page += 1) pageNumbers.push(page);
      const reported = await mapPool(pageNumbers, pageConcurrency, fetchAndStage);
      const maxSeen = Math.max(totalPages, ...reported);
      nextPage = totalPages + 1;
      totalPages = maxSeen;
    }
    flush();
    return { regionId: region.region_id, pages: totalPages, rowsLoaded: regionRows, expiresAt };
  };

  const fetchRegion = async (region: SnapshotRegion): Promise<RegionFetchRecord> => {
    // ESI's order-book cache flips every 5 minutes; a walk that straddles the
    // flip sees a new Last-Modified mid-region. That flip is routine, not
    // corruption: re-walk the region once. The re-walk starts right after the
    // flip and, being far shorter than the window (the pool sees to that),
    // lands inside a single snapshot. Only a SECOND consecutive flip fails
    // the region — the upstream is then genuinely unstable, and the existing
    // warm-fallback / cold-abort semantics take over.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await walkRegion(region);
      } catch (err) {
        if (!(err instanceof SnapshotBookDriftError) || attempt >= MAX_REGION_WALK_ATTEMPTS) throw err;
        // Drop the straddled mix staged so far before re-walking under the
        // new snapshot (unflushed page rows die with the attempt scope).
        dropRegionRows.run(region.region_id);
      }
    }
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
          // Each carry-over is a synchronous INSERT SELECT (~40 ms on an
          // average region; the whole minor tier measured ~2.6 s) and the
          // loop runs them back to back. Yield between regions so a tick
          // never becomes one multi-second event-loop block.
          await yieldToEventLoop();
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
        // Abort only when the region PROMISED rows the serving table can no
        // longer back: a region that legitimately committed zero rows carries
        // zero rows over, and reading that as "cold" would abort every sweep
        // until its ESI endpoint recovered.
        const state = states.get(region.region_id);
        if (carried === 0 && (state === undefined || (state.rows_loaded ?? 0) > 0)) {
          throw new Error(`region ${region.region_id} (${region.name}) failed with no prior rows to keep: ${message}`);
        }
        rowsLoaded += carried;
        regionsCarriedOver += 1;
        regionErrors.push({ regionId: region.region_id, error: message });
        effectiveFetchedAt.set(region.region_id, state?.fetched_at ?? null);
      }
    }
    if (rowsLoaded < minRows) {
      throw new Error(`Snapshot row count ${rowsLoaded} below the sanity floor ${minRows}; refusing to swap`);
    }
    await deriveStationIds(db, rowsLoaded);
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
 * structures (>= 1e12 ids) and anything unknown stay NULL. Chunked into
 * bounded order_id ranges (the primary key, so every range is an indexed
 * scan) with an event-loop yield between chunks: one monolithic UPDATE
 * measured ~0.3 s on 1.6M rows and ran back to back with the carry-over
 * block and the first CREATE INDEX. rowEstimate sizes the chunk count so one
 * chunk stays in the tens of milliseconds.
 */
const STATION_ID_CHUNK_ROWS = 100_000;
const MAX_STATION_ID_CHUNKS = 64;

async function deriveStationIds(db: Db, rowEstimate: number): Promise<void> {
  const bounds = db.prepare(
    `SELECT MIN(order_id) AS lo, MAX(order_id) AS hi FROM ${MARKET_ORDERS_STAGING_TABLE}`,
  ).get() as { lo: number | null; hi: number | null };
  if (bounds.lo === null || bounds.hi === null) return;
  const chunks = Math.min(
    MAX_STATION_ID_CHUNKS,
    Math.max(1, Math.ceil(rowEstimate / STATION_ID_CHUNK_ROWS)),
  );
  const step = Math.ceil((bounds.hi - bounds.lo + 1) / chunks);
  const update = db.prepare(`
    UPDATE ${MARKET_ORDERS_STAGING_TABLE}
    SET station_id = location_id
    WHERE order_id >= ? AND order_id < ?
      AND location_id IN (SELECT station_id FROM sde_stations)
  `);
  for (let i = 0; i < chunks; i += 1) {
    if (i > 0) await yieldToEventLoop();
    update.run(bounds.lo + i * step, bounds.lo + (i + 1) * step);
  }
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

/** Hand the event loop a macrotask turn between back-to-back synchronous SQLite blocks. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * Build the indexes on the filled staging table, one statement at a time with
 * an event-loop yield before each. Measured on 1.6M rows (see
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
  for (const { base, columns } of STAGING_INDEXES) {
    await yieldToEventLoop();
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
 * Tier schedule the freshness view works against. staleMinutes is a GRACE
 * allowance past a region's own tier interval, not a flat age threshold: a
 * healthy minor-tier book is legitimately hours old, and a flat threshold
 * below the minor interval would read it as permanently stale — a consumer
 * falling back to live ESI on `stale` would bypass the snapshot forever.
 */
export type MarketSnapshotFreshness = {
  staleMinutes: number;
  majorMinPages: number;
  majorIntervalMinutes: number;
  minorIntervalMinutes: number;
};

function isRegionStale(
  row: MarketSnapshotRegionRow,
  nowMs: number,
  freshness: MarketSnapshotFreshness,
): boolean {
  const fetchedMs = row.fetched_at !== null ? Date.parse(row.fetched_at) : NaN;
  if (!Number.isFinite(fetchedMs)) return true; // unknown age reads as stale
  const intervalMinutes = (row.pages ?? 0) >= freshness.majorMinPages
    ? freshness.majorIntervalMinutes
    : freshness.minorIntervalMinutes;
  return nowMs > fetchedMs + (intervalMinutes + freshness.staleMinutes) * 60_000;
}

/**
 * Freshness view attached to every market-snapshot tool response so the agent
 * physically cannot answer without seeing the data age. snapshot_time is the
 * OLDEST region's fetched_at in the serving book — the swapped table mixes
 * rows of different ages (tier intervals, mid-sweep failures), so the tick
 * time would lie. Per-region ages ride along so the agent can cite the exact
 * region's age instead of the book-wide worst case. A region is stale only
 * once it is past its own tier interval plus the staleMinutes grace; the book
 * is stale when any region is or its age is unknown.
 */
export function getMarketSnapshotMeta(
  db: Db,
  freshness: MarketSnapshotFreshness,
  now: Date = new Date(),
): MarketSnapshotMeta {
  const state = getMarketSnapshotState(db);
  const hasRows = db.prepare('SELECT 1 FROM market_orders LIMIT 1').get() !== undefined;
  const nowMs = now.getTime();
  const snapshotTime = state?.snapshot_time ?? null;
  const ageMinutes = ageMinutesOf(snapshotTime, nowMs);
  const regions = getMarketSnapshotRegionStates(db).map((row) => ({
    region_id: row.region_id,
    fetched_at: row.fetched_at,
    age_minutes: ageMinutesOf(row.fetched_at, nowMs),
    stale: isRegionStale(row, nowMs, freshness),
    last_error: row.last_error,
  }));
  return {
    loaded: hasRows,
    status: state?.status ?? 'idle',
    snapshot_time: snapshotTime,
    age_minutes: ageMinutes,
    // Without a timestamp the age is unknown; treat it as stale rather than fresh.
    stale: ageMinutes === null ? true : regions.some((region) => region.stale),
    rows_loaded: state?.rows_loaded ?? null,
    last_error: state?.last_error ?? null,
    regions,
  };
}

// ---------------------------------------------------------------------------
// Manual CLI entry: npx tsx src/eve/market-snapshot-loader.ts
// ---------------------------------------------------------------------------

/**
 * The manual run shares the bot's single-process invariant: both rebuild
 * market_orders_next, and two writers would drop and refill the staging table
 * under each other ("no such table" mid-sweep). Same lock path as the bot
 * service, a distinct runtime name so a busy lock says exactly who owns it.
 */
export function acquireMarketSnapshotLoaderLock(dbPath: string): RuntimeLock {
  return acquireRuntimeLock(dbPath, 'market snapshot loader');
}

async function main(): Promise<void> {
  const { initDb } = await import('../db/sqlite.js');
  const { runMigrations } = await import('../db/migrations.js');
  const { loadTradeRegions } = await import('./market-wide-summary.js');

  // Refuses with the owner's identity when the bot service already holds it.
  const lock = acquireMarketSnapshotLoaderLock(config.db.path);
  const db = initDb(config.db.path);
  try {
    runMigrations(db);
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
      pageConcurrency: config.marketSnapshot.pageConcurrency,
    });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[market-snapshot] swept=${result.swept} rows=${result.rowsLoaded} in ${seconds}s `
      + `(fetched ${result.regionsFetched} regions, carried over ${result.regionsCarriedOver}, `
      + `${result.malformedRows} malformed skipped, ${result.regionErrors.length} region errors)`,
    );
  } finally {
    db.close();
    lock.release();
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
