/** Defensive client for the public EVE-KILL v1 REST API. */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { fetchRetrying } from '../eve/http.js';
import {
  parseBatchEntityStats,
  parseEntityStats,
  parseFeedPage,
  parseEsiKillmail,
  parseKillmailDetail,
  parseKillmailPage,
  parseSearchPage,
} from './normalize.js';
import {
  SEARCH_FILTER_KEYS,
  type ApiResult,
  type BatchEntityStats,
  type EntityApiScope,
  type EntityScope,
  type EntityStats,
  type EveKillConfig,
  type FeedPage,
  type KillmailActivity,
  type KillmailCollection,
  type KillmailSearchRequest,
  type KillmailSearchResult,
  type NormalizedKillmail,
  type SearchFilterKey,
} from './types.js';

export type {
  ApiResult,
  BatchEntityStats,
  EntityStats,
  FeedPage,
  KillmailCollection,
  KillmailSearchRequest,
  KillmailSearchResult,
  NormalizedKillmail,
} from './types.js';

export const EVE_KILL_API_BASE_URL = 'https://api.eve-kill.com/';
const CACHE_VERSION = 'evekill:v2';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_IDS_PER_FILTER = 15;
const MAX_FILTER_CATEGORIES = 3;
const DEFAULT_RESULT_LIMIT = 250;
const MAX_RESULT_LIMIT = 2_500;
const DEFAULT_MAX_REQUESTS = 256;
const INITIAL_BEFORE_CURSOR = 2_147_483_647;

type JsonParser<T> = (value: unknown) => T;

export type CollectionOptions = {
  from?: string;
  to?: string;
  limit?: number;
  maxRequests?: number;
};

export function eveKillKillmailUrl(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('killmail id must be a positive integer');
  return `https://eve-kill.com/kill/${id}`;
}

export function getEveKillConfig(): EveKillConfig {
  return {
    baseUrl: EVE_KILL_API_BASE_URL,
    timeoutMs: config.eveKill.timeoutMs,
    userAgent: config.eveKill.userAgent,
    retryMaxAttempts: config.eveKill.retryMaxAttempts,
    backoffMaxMs: config.eveKill.backoffMaxMs,
  };
}

export async function getKillmailDetail(db: Db, id: number): Promise<ApiResult<NormalizedKillmail>> {
  if (!validId(id)) return invalid('killmail id must be a positive integer');
  return await cachedParsed(db, 'GET', `killmails/${id}`, undefined, undefined, (value) => {
    const kill = parseKillmailDetail(value);
    if (kill.killmailId !== id) throw new Error('killmail id mismatch');
    return kill;
  }, 600);
}

/**
 * EVE-KILL's ESI-shaped public response. This is not an official CCP ESI call;
 * callers holding (id, hash) must use the repository's official ESI client.
 */
export async function getKillmailEsi(db: Db, id: number): Promise<ApiResult<NormalizedKillmail>> {
  if (!validId(id)) return invalid('killmail id must be a positive integer');
  const result = await cachedParsed(
    db,
    'GET',
    `killmails/${id}/esi`,
    undefined,
    undefined,
    (value) => {
      const kill = parseEsiKillmail(value);
      if (kill.killmailId !== id) throw new Error('killmail id mismatch');
      return kill;
    },
    600,
  );
  return result;
}

export async function getKillmailDetails(
  db: Db,
  ids: number[],
  options: { limit?: number; concurrency?: number } = {},
): Promise<ApiResult<KillmailCollection>> {
  if (ids.length > MAX_RESULT_LIMIT) return invalid(`at most ${MAX_RESULT_LIMIT} killmail ids are supported`);
  if (ids.some((id) => !validId(id))) return invalid('killmail ids must be positive integers');
  const limit = boundedLimit(options.limit, DEFAULT_RESULT_LIMIT);
  const concurrency = Math.max(1, Math.min(10, Math.trunc(options.concurrency ?? 4)));
  const unique = uniqueIds(ids).slice(0, limit);
  const kills: NormalizedKillmail[] = [];
  let index = 0;
  let firstError: string | null = null;

  const worker = async (): Promise<void> => {
    while (index < unique.length) {
      const id = unique[index++]!;
      const result = await getKillmailDetail(db, id);
      if (result.ok) kills.push(result.data);
      else if (!firstError) firstError = result.error;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  if (kills.length === 0 && firstError) return { ok: false, error: firstError };
  sortKills(kills);
  return {
    ok: true,
    data: {
      kills,
      truncated: ids.length > unique.length || kills.length < unique.length,
      requestCount: unique.length,
    },
  };
}

export async function getKillmailFitting(
  db: Db,
  id: number,
): Promise<ApiResult<Record<string, unknown>>> {
  if (!validId(id)) return invalid('killmail id must be a positive integer');
  return await cachedParsed(db, 'GET', `killmails/${id}/fitting`, undefined, undefined, (value) => parseFitting(value, id), 600);
}

export async function listSystemKills(
  db: Db,
  systemId: number,
  options: CollectionOptions = {},
): Promise<ApiResult<KillmailSearchResult>> {
  if (!validId(systemId)) return invalid('system id must be a positive integer');
  return await collectSummaryPages(db, `sde/systems/${systemId}/kills`, undefined, options);
}

export async function listEntityActivity(
  db: Db,
  scope: EntityScope,
  id: number,
  activity: KillmailActivity,
  options: CollectionOptions = {},
): Promise<ApiResult<KillmailSearchResult>> {
  if (!validId(id)) return invalid('entity id must be a positive integer');
  if (!['character', 'corporation', 'alliance'].includes(scope)) return invalid('invalid entity scope');
  if (!['kills', 'losses', 'all'].includes(activity)) return invalid('invalid activity');
  const plural = `${scope}s` as EntityApiScope;

  if (activity !== 'all') {
    const result = await collectSummaryPages(db, `${plural}/${id}/${activity}`, activity, options);
    return result;
  }

  const limit = boundedLimit(options.limit, DEFAULT_RESULT_LIMIT);
  const [killsResult, lossesResult] = await Promise.all([
    collectSummaryPages(db, `${plural}/${id}/kills`, 'kills', { ...options, limit }),
    collectSummaryPages(db, `${plural}/${id}/losses`, 'losses', { ...options, limit }),
  ]);
  if (!killsResult.ok) return killsResult;
  if (!lossesResult.ok) return lossesResult;
  const merged = dedupeKills([...killsResult.data.kills, ...lossesResult.data.kills]);
  const truncated = killsResult.data.truncated || lossesResult.data.truncated || merged.length > limit;
  return {
    ok: true,
    data: {
      kills: merged.slice(0, limit),
      truncated,
      requestCount: killsResult.data.requestCount + lossesResult.data.requestCount,
      windows: requestedWindows(options),
    },
  };
}

export async function searchKillmails(
  db: Db,
  request: KillmailSearchRequest,
  options: { limit?: number; maxRequests?: number } = {},
): Promise<ApiResult<KillmailSearchResult>> {
  const limit = boundedLimit(options.limit, DEFAULT_RESULT_LIMIT);
  const maxRequests = Math.max(1, Math.min(1_000, Math.trunc(options.maxRequests ?? DEFAULT_MAX_REQUESTS)));
  const validated = validateSearchRequest(request, maxRequests);
  if (!validated.ok) return validated;
  const windows = splitWindows(validated.data.from, validated.data.to);
  const filterBodies = expandFilterChunks(validated.data.filters);
  const byId = new Map<number, NormalizedKillmail>();
  let requestCount = 0;
  let truncated = false;

  outer:
  for (let windowIndex = windows.length - 1; windowIndex >= 0; windowIndex -= 1) {
    const window = windows[windowIndex]!;
    for (const filters of filterBodies) {
      let after: number | undefined;
      const seenCursors = new Set<number>();
      for (;;) {
        if (requestCount >= maxRequests) {
          truncated = true;
          break outer;
        }
        const body: Record<string, unknown> = {
          from: window.from,
          to: window.to,
          limit: Math.min(MAX_PAGE_SIZE, Math.max(1, limit - byId.size)),
          ...filters,
        };
        if (after !== undefined) body.after = after;
        requestCount += 1;
        const page = await cachedParsed(db, 'POST', 'killmails/search', undefined, body, parseSearchPage, 90);
        if (!page.ok) return page;
        for (const kill of page.data.kills) byId.set(kill.killmailId, kill);
        if (byId.size >= limit) {
          truncated = byId.size > limit
            || page.data.pagination.hasMore
            || hasRemainingSearchWork(windowIndex, windows, filters, filterBodies);
          break outer;
        }
        const cursor = page.data.pagination.cursor;
        if (!page.data.pagination.hasMore || cursor === null) break;
        if (seenCursors.has(cursor)) return invalid('EVE-KILL search returned a repeated cursor');
        seenCursors.add(cursor);
        after = cursor;
      }
    }
  }

  const kills = [...byId.values()];
  sortKills(kills);
  return { ok: true, data: { kills: kills.slice(0, limit), truncated, requestCount, windows } };
}

export async function batchCharacterStats(
  db: Db,
  ids: number[],
  period: { type: 'alltime' | 'weekly' } | { type: 'range'; from: string; to: string },
): Promise<ApiResult<BatchEntityStats>> {
  if (ids.length > MAX_RESULT_LIMIT) return invalid(`at most ${MAX_RESULT_LIMIT} character ids are supported`);
  if (ids.some((id) => !validId(id))) return invalid('character ids must be positive integers');
  const requestedIds = uniqueIds(ids);
  if (requestedIds.length === 0) return invalid('at least one character id is required');
  if (period.type === 'range') {
    if (!validDate(period.from) || !validDate(period.to) || Date.parse(period.from) > Date.parse(period.to)) {
      return invalid('invalid character stats range');
    }
  }
  const requestedSet = new Set(requestedIds);
  const resultsById = new Map<number, EntityStats>();
  let responsePeriod: string | null = null;
  let requestCount = 0;
  for (let i = 0; i < requestedIds.length; i += 100) {
    const body: Record<string, unknown> = { ids: requestedIds.slice(i, i + 100), type: period.type };
    if (period.type === 'range') {
      body.from = period.from;
      body.to = period.to;
    }
    requestCount += 1;
    const response = await cachedParsed(db, 'POST', 'characters/stats', undefined, body, parseBatchEntityStats, 600);
    if (!response.ok) return response;
    if (responsePeriod !== null && response.data.period !== responsePeriod) {
      return invalid('EVE-KILL character stats returned inconsistent periods');
    }
    responsePeriod = response.data.period;
    for (const entry of response.data.results) {
      if (!requestedSet.has(entry.id)) return invalid('EVE-KILL character stats returned an unrequested id');
      if (resultsById.has(entry.id)) return invalid('EVE-KILL character stats returned a duplicate id');
      resultsById.set(entry.id, entry);
    }
  }
  const results = requestedIds.flatMap((id) => {
    const entry = resultsById.get(id);
    return entry ? [entry] : [];
  });
  const resolvedIds = results.map((entry) => entry.id);
  const resolvedSet = new Set(resolvedIds);
  const missingIds = requestedIds.filter((id) => !resolvedSet.has(id));
  return {
    ok: true,
    data: {
      period: responsePeriod ?? period.type,
      results,
      requestedIds,
      resolvedIds,
      missingIds,
      truncated: missingIds.length > 0,
      requestCount,
    },
  };
}

export async function getCharacterStats(
  db: Db,
  id: number,
  period: { type: 'alltime' | 'weekly' } | { type: 'range'; from: string; to: string },
): Promise<ApiResult<EntityStats>> {
  if (!validId(id)) return invalid('character id must be a positive integer');
  const params: Record<string, string | number> = { type: period.type };
  if (period.type === 'range') {
    if (!validDate(period.from) || !validDate(period.to) || Date.parse(period.from) > Date.parse(period.to)) {
      return invalid('invalid character stats range');
    }
    params.from = period.from;
    params.to = period.to;
  }
  return await cachedParsed(db, 'GET', `characters/${id}/stats`, params, undefined, (value) => {
    const stats = parseEntityStats(value);
    if (stats.id !== id) throw new Error('character stats id mismatch');
    return stats;
  }, 600);
}

export async function getCharacterIntel(
  db: Db,
  id: number,
  days = 365,
): Promise<ApiResult<Record<string, unknown>>> {
  if (!validId(id)) return invalid('character id must be a positive integer');
  const boundedDays = Math.max(7, Math.min(365, Math.trunc(days)));
  return await cachedParsed(db, 'GET', `characters/${id}/intel`, { days: boundedDays }, undefined, (value) => {
    const row = parseCharacterIntel(value, id);
    return row;
  }, 600);
}

const LEADERBOARD_TYPES = new Set([
  'characters', 'corporations', 'alliances', 'ships', 'systems', 'regions',
  'isk_destroyers_chars', 'isk_destroyers_corps', 'isk_destroyers_alliances',
  'solo_killers', 'top_points', 'biggest_losers', 'most_used_ships',
  'most_destroyed_ships', 'dangerous_systems', 'deadliest_regions',
  'pirate_characters', 'carebear_characters', 'most_valuable_ships',
  'most_valuable_structures',
]);

export async function getLeaderboard(
  db: Db,
  dataType: string,
  days = 7,
  limit = 10,
): Promise<ApiResult<Record<string, unknown>>> {
  if (!LEADERBOARD_TYPES.has(dataType)) return invalid('unsupported leaderboard type');
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return await cachedParsed(db, 'GET', 'stats', {
    dataType,
    days: Math.max(1, Math.min(365, Math.trunc(days))),
    limit: boundedLimit,
  }, undefined, (value) => parseLeaderboard(value, boundedLimit), 300);
}

export async function listBattles(
  db: Db,
  options: { page?: number; limit?: number; sort?: 'battle_id' | 'total_isk_destroyed' | 'kill_count' | 'start_time' } = {},
): Promise<ApiResult<Record<string, unknown>>> {
  const page = Math.max(1, Math.min(500, Math.trunc(options.page ?? 1)));
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)));
  const sort = options.sort ?? 'battle_id';
  return await cachedParsed(db, 'GET', 'battles', { page, limit, sort, order: 'desc' }, undefined, (value) => {
    return parseBattleList(value, page, limit);
  }, 300);
}

export async function getBattle(db: Db, id: number, memberLimit = 100): Promise<ApiResult<Record<string, unknown>>> {
  if (!validId(id)) return invalid('battle id must be a positive integer');
  return await cachedParsed(db, 'GET', `battles/${id}`, undefined, undefined, (value) => {
    return parseBattleDetail(value, id, memberLimit);
  }, 300);
}

export async function fetchFeedPage(after: number, limit = 100): Promise<ApiResult<FeedPage>> {
  if (!Number.isSafeInteger(after) || after < 0) return invalid('feed cursor must be a non-negative integer');
  const bounded = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  return await requestParsed('GET', 'feed/poll', { after, limit: bounded }, undefined, (value) => {
    const page = parseFeedPage(value);
    if (page.events.length > bounded) throw new Error('feed page exceeded requested limit');
    return page;
  });
}

async function collectSummaryPages(
  db: Db,
  path: string,
  activity: Exclude<KillmailActivity, 'all'> | undefined,
  options: CollectionOptions,
): Promise<ApiResult<KillmailSearchResult>> {
  const limit = boundedLimit(options.limit, DEFAULT_RESULT_LIMIT);
  const maxRequests = Math.max(1, Math.min(1_000, Math.trunc(options.maxRequests ?? DEFAULT_MAX_REQUESTS)));
  const fromMs = options.from ? Date.parse(options.from) : null;
  const toMs = options.to ? Date.parse(options.to) : null;
  if (fromMs !== null && !Number.isFinite(fromMs)) return invalid('invalid from date');
  if (toMs !== null && !Number.isFinite(toMs)) return invalid('invalid to date');
  if (fromMs !== null && toMs !== null && fromMs > toMs) return invalid('from must not be after to');

  const byId = new Map<number, NormalizedKillmail>();
  let before = INITIAL_BEFORE_CURSOR;
  const seenCursors = new Set<number>();
  let requestCount = 0;
  let truncated = false;

  for (;;) {
    if (requestCount >= maxRequests) { truncated = true; break; }
    requestCount += 1;
    const page = await cachedParsed(
      db,
      'GET',
      path,
      { before, limit: Math.min(MAX_PAGE_SIZE, Math.max(1, limit - byId.size)) },
      undefined,
      parseKillmailPage,
      120,
    );
    if (!page.ok) return page;
    let crossedLowerBound = false;
    for (const kill of page.data.kills) {
      const timeMs = kill.killmailTime ? Date.parse(kill.killmailTime) : NaN;
      if (fromMs !== null && Number.isFinite(timeMs) && timeMs < fromMs) {
        crossedLowerBound = true;
        continue;
      }
      if (toMs !== null && Number.isFinite(timeMs) && timeMs > toMs) continue;
      kill.activity = activity;
      byId.set(kill.killmailId, kill);
    }
    if (byId.size >= limit) {
      truncated = byId.size > limit || page.data.pagination.hasMore;
      break;
    }
    const cursor = page.data.pagination.cursor;
    if (crossedLowerBound || !page.data.pagination.hasMore || cursor === null) break;
    if (seenCursors.has(cursor)) return invalid('EVE-KILL list returned a repeated cursor');
    seenCursors.add(cursor);
    before = cursor;
  }

  const kills = [...byId.values()];
  sortKills(kills);
  return {
    ok: true,
    data: { kills: kills.slice(0, limit), truncated, requestCount, windows: requestedWindows(options) },
  };
}

async function cachedParsed<T>(
  db: Db,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | number> | undefined,
  body: unknown,
  parser: JsonParser<T>,
  ttlSeconds: number,
): Promise<ApiResult<T>> {
  const cacheKey = `${CACHE_VERSION}:${method}:${path}:${stableJson(params ?? {})}:${stableJson(body ?? null)}`;
  const cached = readCache(db, cacheKey);
  if (cached !== null) {
    try { return { ok: true, data: parser(cached) }; } catch { /* refetch malformed/stale cache */ }
  }
  const response = await requestJson(method, path, params, body);
  if (!response.ok) return response;
  let parsed: T;
  try {
    parsed = parser(response.data);
  } catch (error) {
    return { ok: false, error: `EVE-KILL invalid response: ${(error as Error).message}` };
  }
  writeCache(db, cacheKey, response.data, ttlSeconds);
  return { ok: true, data: parsed };
}

async function requestParsed<T>(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | number> | undefined,
  body: unknown,
  parser: JsonParser<T>,
): Promise<ApiResult<T>> {
  const response = await requestJson(method, path, params, body);
  if (!response.ok) return response;
  try { return { ok: true, data: parser(response.data) }; }
  catch (error) { return { ok: false, error: `EVE-KILL invalid response: ${(error as Error).message}` }; }
}

async function requestJson(
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string | number>,
  body?: unknown,
): Promise<ApiResult<unknown>> {
  const cfg = getEveKillConfig();
  const url = new URL(path.replace(/^\/+/, ''), cfg.baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  const init: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'User-Agent': cfg.userAgent,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  };
  try {
    const response = await fetchRetrying(url, init, {
      maxAttempts: cfg.retryMaxAttempts,
      backoffMaxMs: cfg.backoffMaxMs,
      timeoutMs: cfg.timeoutMs,
    });
    if (!response.ok) return { ok: false, error: `EVE-KILL HTTP ${response.status}`, status: response.status };
    return { ok: true, data: await readJsonCapped(response) };
  } catch (error) {
    return { ok: false, error: `EVE-KILL request failed: ${(error as Error).message}` };
  }
}

async function readJsonCapped(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response too large');
  if (!response.body) return await response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('response exceeded size cap');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(merged)) as unknown;
}

function readCache(db: Db, key: string): unknown | null {
  const row = db.prepare(
    "SELECT response_text FROM esi_cache WHERE cache_key = ? AND expires_at > datetime('now')",
  ).get(key) as { response_text: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.response_text) as unknown; } catch { return null; }
}

function writeCache(db: Db, key: string, payload: unknown, ttlSeconds: number): void {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(cache_key) DO UPDATE SET
      response_text = excluded.response_text,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).run(key, JSON.stringify(payload), expiresAt);
}

function validateSearchRequest(request: KillmailSearchRequest, maxRequests: number): ApiResult<{
  from: string;
  to: string;
  filters: Partial<Record<SearchFilterKey, number[]>>;
}> {
  if (!validDate(request.from) || !validDate(request.to)) return invalid('search requires valid from/to dates');
  const fromMs = Date.parse(request.from);
  const toMs = Date.parse(request.to);
  if (fromMs >= toMs) return invalid('search from must be before to');
  const filters: Partial<Record<SearchFilterKey, number[]>> = {};
  let filterCombinations = 1;
  for (const key of SEARCH_FILTER_KEYS) {
    const raw = request[key];
    if (raw !== undefined && (!Array.isArray(raw) || raw.some((id) => !validId(id)))) {
      return invalid(`${key} must contain only positive integer IDs`);
    }
    if (raw && raw.length > MAX_IDS_PER_FILTER * maxRequests) {
      return invalid(`${key} exceeds the bounded search plan`);
    }
    const values = uniqueIds(raw ?? []);
    if (values.length > 0) {
      filters[key] = values;
      filterCombinations *= Math.ceil(values.length / MAX_IDS_PER_FILTER);
    }
  }
  if (Object.keys(filters).length > MAX_FILTER_CATEGORIES) {
    return invalid(`search supports at most ${MAX_FILTER_CATEGORIES} filter categories`);
  }
  // EVE-KILL treats both bounds as inclusive. Account for the inclusive final
  // millisecond so adjacent windows can be disjoint without exceeding seven
  // days of represented time.
  const windowCount = Math.ceil((toMs - fromMs + 1) / MAX_SEARCH_WINDOW_MS);
  if (!Number.isSafeInteger(windowCount) || windowCount * filterCombinations > maxRequests) {
    return invalid('search plan exceeds the bounded request budget');
  }
  return { ok: true, data: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), filters } };
}

function splitWindows(from: string, to: string): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  const fromMs = Date.parse(from);
  let cursor = fromMs;
  const toMs = Date.parse(to);
  while (cursor <= toMs) {
    const end = Math.min(toMs, cursor + MAX_SEARCH_WINDOW_MS - 1);
    windows.push({ from: new Date(cursor).toISOString(), to: new Date(end).toISOString() });
    if (end === toMs) break;
    cursor = end + 1;
  }
  return windows;
}

function expandFilterChunks(
  filters: Partial<Record<SearchFilterKey, number[]>>,
): Array<Partial<Record<SearchFilterKey, number[]>>> {
  let bodies: Array<Partial<Record<SearchFilterKey, number[]>>> = [{}];
  for (const key of SEARCH_FILTER_KEYS) {
    const values = filters[key];
    if (!values || values.length === 0) continue;
    const chunks: number[][] = [];
    for (let i = 0; i < values.length; i += MAX_IDS_PER_FILTER) chunks.push(values.slice(i, i + MAX_IDS_PER_FILTER));
    bodies = bodies.flatMap((body) => chunks.map((chunk) => ({ ...body, [key]: chunk })));
  }
  return bodies;
}

function requestedWindows(options: CollectionOptions): Array<{ from: string; to: string }> {
  if (!options.from && !options.to) return [];
  return [{
    from: options.from ? new Date(Date.parse(options.from)).toISOString() : '',
    to: options.to ? new Date(Date.parse(options.to)).toISOString() : '',
  }];
}

function hasRemainingSearchWork(
  windowIndex: number,
  windows: Array<{ from: string; to: string }>,
  filters: Partial<Record<SearchFilterKey, number[]>>,
  allFilters: Array<Partial<Record<SearchFilterKey, number[]>>>,
): boolean {
  return windowIndex > 0 || allFilters.indexOf(filters) < allFilters.length - 1 || windows.length === 0;
}

function dedupeKills(kills: NormalizedKillmail[]): NormalizedKillmail[] {
  const map = new Map<number, NormalizedKillmail>();
  for (const kill of kills) {
    const existing = map.get(kill.killmailId);
    if (!existing) {
      map.set(kill.killmailId, kill);
    } else if (
      existing.activity
      && kill.activity
      && existing.activity !== kill.activity
    ) {
      map.set(kill.killmailId, { ...existing, activity: 'all' });
    }
  }
  const result = [...map.values()];
  sortKills(result);
  return result;
}

function sortKills(kills: NormalizedKillmail[]): void {
  kills.sort((left, right) => {
    const timeDiff = Date.parse(right.killmailTime ?? '') - Date.parse(left.killmailTime ?? '');
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return right.killmailId - left.killmailId;
  });
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids.filter(validId))];
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validDate(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(value ?? fallback)));
}

function invalid(error: string): ApiResult<never> {
  return { ok: false, error };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('response must be an object');
  return value as Record<string, unknown>;
}

function parseFitting(value: unknown, expectedKillmailId: number): Record<string, unknown> {
  const row = parseRecord(value);
  if (positiveInteger(row.killmail_id, 'killmail_id') !== expectedKillmailId) throw new Error('fitting killmail id mismatch');
  const ship = parseRecord(row.ship);
  const result: Record<string, unknown> = {
    killmail_id: expectedKillmailId,
    ship: {
      type_id: positiveInteger(ship.type_id, 'ship.type_id'),
      name: nonEmptyString(ship.name, 'ship.name'),
    },
  };
  let remaining = 500;
  let truncated = false;
  for (const slot of ['high', 'mid', 'low', 'rig', 'subsystem', 'drone', 'fighter', 'cargo', 'implant', 'other']) {
    if (row[slot] === undefined) continue;
    if (!Array.isArray(row[slot])) throw new Error(`fitting ${slot} must be an array`);
    const items = row[slot].map((entry) => {
      const item = parseRecord(entry);
      return {
        type_id: positiveInteger(item.type_id, `${slot}.type_id`),
        name: nonEmptyString(item.name, `${slot}.name`),
        quantity: positiveInteger(item.quantity, `${slot}.quantity`),
      };
    });
    result[slot] = items.slice(0, remaining);
    if (items.length > remaining) truncated = true;
    remaining = Math.max(0, remaining - items.length);
  }
  result.truncated = truncated;
  return result;
}

function parseCharacterIntel(value: unknown, expectedId: number): Record<string, unknown> {
  const row = parseRecord(value);
  if (positiveInteger(row.character_id, 'character_id') !== expectedId) throw new Error('character intel id mismatch');
  const playstyle = parseRecord(row.playstyle);
  const fc = parseRecord(row.fc);
  const tags = stringArray(row.tags, 'tags');
  const shipsFlown = rankedItems(row.ships_flown, 'ships_flown');
  const shipsLost = rankedItems(row.ships_lost, 'ships_lost');
  const targets = rankedItems(row.targets, 'targets');
  const groups = rankedItems(row.groups_flown_with, 'groups_flown_with');
  const partners = rankedItems(row.fleet_partners, 'fleet_partners', true);
  const cap = 20;
  return {
    character_id: expectedId,
    days: positiveInteger(row.days, 'days'),
    playstyle: {
      solo: nonNegativeInteger(playstyle.solo, 'playstyle.solo'),
      small_gang: nonNegativeInteger(playstyle.small_gang, 'playstyle.small_gang'),
      mid_gang: nonNegativeInteger(playstyle.mid_gang, 'playstyle.mid_gang'),
      fleet: nonNegativeInteger(playstyle.fleet, 'playstyle.fleet'),
      blob: nonNegativeInteger(playstyle.blob, 'playstyle.blob'),
      avg_fleet_size: nonNegativeNumber(playstyle.avg_fleet_size, 'playstyle.avg_fleet_size'),
      total_kills: nonNegativeInteger(playstyle.total_kills, 'playstyle.total_kills'),
    },
    dominant_style: nonEmptyString(row.dominant_style, 'dominant_style'),
    tags: tags.slice(0, cap),
    fc: {
      likelihood: nonEmptyString(fc.likelihood, 'fc.likelihood'),
      monitor_appearances: nonNegativeInteger(fc.monitor_appearances, 'fc.monitor_appearances'),
    },
    capital_pilot: requiredBoolean(row.capital_pilot, 'capital_pilot'),
    is_logi: requiredBoolean(row.is_logi, 'is_logi'),
    ships_flown: shipsFlown.slice(0, cap),
    ships_lost: shipsLost.slice(0, cap),
    targets: targets.slice(0, cap),
    fleet_partners: partners.slice(0, cap),
    groups_flown_with: groups.slice(0, cap),
    awox_kills: nonNegativeInteger(row.awox_kills, 'awox_kills'),
    cyno_deaths: nonNegativeInteger(row.cyno_deaths, 'cyno_deaths'),
    bait: nonEmptyString(row.bait, 'bait'),
    bait_count: nonNegativeInteger(row.bait_count, 'bait_count'),
    bridge_score: nonNegativeNumber(row.bridge_score, 'bridge_score'),
    truncated: [tags, shipsFlown, shipsLost, targets, partners, groups].some((items) => items.length > cap),
  };
}

function parseLeaderboard(value: unknown, limit: number): Record<string, unknown> {
  const row = parseRecord(value);
  if (!Array.isArray(row.entries)) throw new Error('leaderboard entries must be an array');
  const entries = row.entries.map((entry) => {
    const item = parseRecord(entry);
    return {
      id: positiveInteger(item.id, 'leaderboard.id'),
      name: nonEmptyString(item.name, 'leaderboard.name'),
      count: nonNegativeNumber(item.count, 'leaderboard.count'),
      type: nonEmptyString(item.type, 'leaderboard.type'),
    };
  });
  return { entries: entries.slice(0, limit), truncated: entries.length > limit };
}

function parseBattleList(value: unknown, expectedPage: number, limit: number): Record<string, unknown> {
  const row = parseRecord(value);
  if (!Array.isArray(row.data)) throw new Error('battle data must be an array');
  const pagination = parseRecord(row.pagination);
  if (positiveInteger(pagination.page, 'pagination.page') !== expectedPage) throw new Error('battle page mismatch');
  positiveInteger(pagination.limit, 'pagination.limit');
  const hasMore = requiredBoolean(pagination.hasMore, 'pagination.hasMore');
  const data = row.data.map(parseBattleSummary);
  return {
    data: data.slice(0, limit),
    pagination: { page: expectedPage, limit, hasMore },
    truncated: data.length > limit || hasMore,
  };
}

function parseBattleDetail(value: unknown, expectedId: number, memberLimit: number): Record<string, unknown> {
  const row = parseRecord(value);
  const battle = parseBattleSummary(row.battle);
  if (battle.battle_id !== expectedId) throw new Error('battle id mismatch');
  if (!Array.isArray(row.teams)) throw new Error('battle teams must be an array');
  let remainingMembers = Math.max(1, Math.min(100, Math.trunc(memberLimit)));
  let truncated = row.teams.length > 20;
  const teams = row.teams.slice(0, 20).map((entry) => {
    const team = parseRecord(entry);
    if (!Array.isArray(team.members)) throw new Error('battle team members must be an array');
    const members = team.members.map(parseBattleMember);
    const selectedMembers = members.slice(0, remainingMembers);
    if (members.length > remainingMembers) truncated = true;
    remainingMembers = Math.max(0, remainingMembers - selectedMembers.length);
    return {
      team_index: nonNegativeInteger(team.team_index, 'team_index'),
      total_kills: nonNegativeInteger(team.total_kills, 'total_kills'),
      total_losses: nonNegativeInteger(team.total_losses, 'total_losses'),
      total_isk_destroyed: nonNegativeNumber(team.total_isk_destroyed, 'total_isk_destroyed'),
      total_isk_lost: nonNegativeNumber(team.total_isk_lost, 'total_isk_lost'),
      members: selectedMembers,
    };
  });
  return { battle, teams, truncated };
}

function parseBattleMember(value: unknown): Record<string, unknown> {
  const row = parseRecord(value);
  return {
    ...(optionalPositiveInteger(row.character_id, 'member.character_id') === undefined ? {} : { character_id: row.character_id }),
    ...(optionalNonEmptyString(row.character_name, 'member.character_name') === undefined ? {} : { character_name: row.character_name }),
    corporation_id: positiveInteger(row.corporation_id, 'member.corporation_id'),
    corporation_name: nonEmptyString(row.corporation_name, 'member.corporation_name'),
    corporation_ticker: nonEmptyString(row.corporation_ticker, 'member.corporation_ticker'),
    ...(optionalPositiveInteger(row.alliance_id, 'member.alliance_id') === undefined ? {} : { alliance_id: row.alliance_id }),
    ...(optionalNonEmptyString(row.alliance_name, 'member.alliance_name') === undefined ? {} : { alliance_name: row.alliance_name }),
    ...(optionalNonEmptyString(row.alliance_ticker, 'member.alliance_ticker') === undefined ? {} : { alliance_ticker: row.alliance_ticker }),
    kills: nonNegativeInteger(row.kills, 'member.kills'),
    losses: nonNegativeInteger(row.losses, 'member.losses'),
    isk_destroyed: nonNegativeNumber(row.isk_destroyed, 'member.isk_destroyed'),
    isk_lost: nonNegativeNumber(row.isk_lost, 'member.isk_lost'),
  };
}

function parseBattleSummary(value: unknown): Record<string, unknown> & { battle_id: number } {
  const row = parseRecord(value);
  return {
    battle_id: positiveInteger(row.battle_id, 'battle_id'),
    solar_system_id: positiveInteger(row.solar_system_id, 'solar_system_id'),
    system_name: nonEmptyString(row.system_name, 'system_name'),
    region_id: positiveInteger(row.region_id, 'region_id'),
    region_name: nonEmptyString(row.region_name, 'region_name'),
    start_time: isoDate(row.start_time, 'start_time'),
    end_time: isoDate(row.end_time, 'end_time'),
    duration_minutes: nonNegativeNumber(row.duration_minutes, 'duration_minutes'),
    kill_count: nonNegativeInteger(row.kill_count, 'kill_count'),
    total_isk_destroyed: nonNegativeNumber(row.total_isk_destroyed, 'total_isk_destroyed'),
    is_multi_party: requiredBoolean(row.is_multi_party, 'is_multi_party'),
    is_custom: requiredBoolean(row.is_custom, 'is_custom'),
  };
}

function rankedItems(value: unknown, label: string, partner = false): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => {
    const row = parseRecord(entry);
    const result: Record<string, unknown> = {
      id: positiveInteger(row.id, `${label}.id`),
      name: nonEmptyString(row.name, `${label}.name`),
      count: nonNegativeInteger(row.count, `${label}.count`),
    };
    if (partner) {
      const corpName = optionalNonEmptyString(row.corp_name, `${label}.corp_name`);
      const allianceName = optionalNonEmptyString(row.alliance_name, `${label}.alliance_name`);
      if (corpName) result.corp_name = corpName;
      if (allianceName) result.alliance_name = allianceName;
    }
    return result;
  });
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => nonEmptyString(entry, label));
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return positiveInteger(value, label);
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return nonEmptyString(value, label);
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}
