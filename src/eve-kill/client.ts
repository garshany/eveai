/**
 * EVE-KILL HTTP client with caching.
 * All REST calls go through this module.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { fetchRetrying } from '../eve/http.js';
import type {
  EveKillKillmail,
  QueryRequest,
  QueryResponse,
  EntityStats,
  TopEntry,
  BattleSummary,
  SearchResult,
  BuildPrice,
  EveKillConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Config accessor
// ---------------------------------------------------------------------------

export function getEveKillConfig(): EveKillConfig {
  return config.eveKill;
}

// ---------------------------------------------------------------------------
// Core HTTP
// ---------------------------------------------------------------------------

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

function retryOpts(cfg: EveKillConfig) {
  return { maxAttempts: cfg.retryMaxAttempts, backoffMaxMs: cfg.backoffMaxMs, timeoutMs: cfg.timeoutMs };
}

async function apiGet<T>(path: string, params?: Record<string, string | number>): Promise<ApiResult<T>> {
  const cfg = getEveKillConfig();
  const base = cfg.baseUrl.endsWith('/') ? cfg.baseUrl : `${cfg.baseUrl}/`;
  const url = new URL(path.replace(/^\/+/, ''), base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }

  try {
    const res = await fetchRetrying(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': cfg.userAgent,
      },
    }, retryOpts(cfg));
    if (!res.ok) {
      console.warn('[eve-kill] GET %s → %d', path, res.status);
      return { ok: false, error: `EVE-KILL HTTP ${res.status}`, status: res.status };
    }
    const data = await res.json() as T;
    return { ok: true, data };
  } catch (err) {
    console.warn('[eve-kill] GET %s failed: %s', path, (err as Error).message);
    return { ok: false, error: `EVE-KILL request failed: ${(err as Error).message}` };
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const cfg = getEveKillConfig();
  const base = cfg.baseUrl.endsWith('/') ? cfg.baseUrl : `${cfg.baseUrl}/`;
  const url = new URL(path.replace(/^\/+/, ''), base);

  try {
    const res = await fetchRetrying(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': cfg.userAgent,
      },
      body: JSON.stringify(body),
    }, retryOpts(cfg));
    if (!res.ok) {
      console.warn('[eve-kill] POST %s → %d', path, res.status);
      return { ok: false, error: `EVE-KILL HTTP ${res.status}`, status: res.status };
    }
    const data = await res.json() as T;
    return { ok: true, data };
  } catch (err) {
    console.warn('[eve-kill] POST %s failed: %s', path, (err as Error).message);
    return { ok: false, error: `EVE-KILL request failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Cache layer (reuses esi_cache table)
// ---------------------------------------------------------------------------

function readCache<T>(db: Db, key: string): T | null {
  const row = db.prepare(
    "SELECT response_text FROM esi_cache WHERE cache_key = ? AND expires_at > datetime('now')",
  ).get(key) as { response_text: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.response_text) as T;
  } catch {
    return null;
  }
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

function cacheTtl(pastSeconds?: number): number {
  const cfg = getEveKillConfig();
  if (!pastSeconds) return cfg.cacheTtlSeconds;
  return Math.max(60, Math.min(cfg.cacheTtlSeconds, Math.floor(pastSeconds / 4)));
}

// ---------------------------------------------------------------------------
// Cached GET helper
// ---------------------------------------------------------------------------

async function cachedGet<T>(
  db: Db,
  cachePrefix: string,
  path: string,
  params?: Record<string, string | number>,
  ttlSeconds?: number,
): Promise<ApiResult<T>> {
  const paramStr = params ? Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&') : '';
  const cacheKey = `evekill:${cachePrefix}:${path}:${paramStr}`;
  const cached = readCache<T>(db, cacheKey);
  if (cached !== null) {
    return { ok: true, data: cached };
  }
  const result = await apiGet<T>(path, params);
  if (result.ok) {
    writeCache(db, cacheKey, result.data, ttlSeconds ?? getEveKillConfig().cacheTtlSeconds);
  }
  return result;
}

async function cachedPost<T>(
  db: Db,
  cachePrefix: string,
  cacheIdentifier: string,
  path: string,
  body: unknown,
  ttlSeconds?: number,
): Promise<ApiResult<T>> {
  const cacheKey = `evekill:${cachePrefix}:${cacheIdentifier}`;
  const cached = readCache<T>(db, cacheKey);
  if (cached !== null) {
    return { ok: true, data: cached };
  }
  const result = await apiPost<T>(path, body);
  if (result.ok) {
    writeCache(db, cacheKey, result.data, ttlSeconds ?? getEveKillConfig().cacheTtlSeconds);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API: Killmails
// ---------------------------------------------------------------------------

export async function getKillmail(db: Db, id: number): Promise<ApiResult<EveKillKillmail>> {
  return cachedGet(db, 'km', `killmail/${id}`, undefined, 600);
}

export async function getKillmailBatch(db: Db, ids: number[]): Promise<ApiResult<EveKillKillmail[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const hashKey = ids.slice().sort((a, b) => a - b).join(',');
  return cachedPost(db, 'km-batch', hashKey, 'killmail/batch', { ids }, 600);
}

export async function getKillmailSibling(db: Db, id: number): Promise<ApiResult<EveKillKillmail>> {
  return cachedGet(db, 'km-sib', `killmail/${id}/sibling`, undefined, 600);
}

export async function getKillmailNearCelestial(
  db: Db,
  celestialId: number,
  distanceMeters: number,
  days: number,
): Promise<ApiResult<EveKillKillmail[]>> {
  return cachedGet(db, 'km-near', 'killmail/nearCelestial', {
    celestial_id: celestialId,
    distanceInMeters: distanceMeters,
    days,
  }, cacheTtl(days * 86400));
}

export async function getKillmailNearCoordinates(
  db: Db,
  systemId: number,
  x: number, y: number, z: number,
  distanceMeters: number,
  days: number,
  limit = 50,
): Promise<ApiResult<EveKillKillmail[]>> {
  return cachedGet(db, 'km-nearcoord', 'killmail/nearCoordinates', {
    system_id: systemId, x, y, z,
    distanceInMeters: distanceMeters,
    days, limit,
  }, cacheTtl(days * 86400));
}

// ---------------------------------------------------------------------------
// Public API: Entity Details
// ---------------------------------------------------------------------------

export async function getEntityDetail(
  db: Db, scope: EntityScope, id: number,
): Promise<ApiResult<unknown>> {
  return cachedGet(db, `${scope}-detail`, `${scope}/${id}`, undefined, 600);
}

// ---------------------------------------------------------------------------
// Public API: Wars
// ---------------------------------------------------------------------------

export async function getWar(db: Db, id: number): Promise<ApiResult<unknown>> {
  return cachedGet(db, 'war', `wars/${id}`, undefined, 600);
}

export async function getWarKillmails(db: Db, id: number): Promise<ApiResult<unknown>> {
  return cachedGet(db, 'war-kms', `wars/${id}/killmails`, undefined, 300);
}

// ---------------------------------------------------------------------------
// Public API: Factions
// ---------------------------------------------------------------------------

export async function getFaction(db: Db, id: number): Promise<ApiResult<unknown>> {
  return cachedGet(db, 'faction', `factions/${id}`, undefined, 3600);
}

// ---------------------------------------------------------------------------
// Public API: Alliance Corporations
// ---------------------------------------------------------------------------

export async function getAllianceCorporations(
  db: Db, id: number, page = 1, limit = 100,
): Promise<ApiResult<unknown[]>> {
  return cachedGet(db, 'alliance-corps', `alliances/${id}/corporations`, { page, limit }, 600);
}

// ---------------------------------------------------------------------------
// Public API: Killlist (the WORKING endpoint — replaces /api/query which is 404)
// Supports: system_id, character_id, corporation_id, alliance_id,
//           ship_type_id, region_id, limit, page
// ---------------------------------------------------------------------------

export type KilllistItem = {
  killmail_id: number;
  killmail_time?: string;
  total_value?: number;
  attacker_count?: number;
  is_npc?: boolean;
  is_solo?: boolean;
  ship_type_id?: number;
  ship_name?: string;
  ship_group_name?: string;
  victim_character_id?: number;
  victim_character_name?: string;
  victim_corporation_id?: number;
  victim_corporation_name?: string;
  victim_alliance_id?: number | null;
  victim_alliance_name?: string | null;
  final_blow_character_id?: number;
  final_blow_character_name?: string;
  final_blow_corporation_id?: number;
  final_blow_corporation_name?: string;
  final_blow_alliance_id?: number | null;
  final_blow_alliance_name?: string | null;
  solar_system_id?: number;
  solar_system_name?: string;
  solar_system_security?: number;
  region_id?: number;
  region_name?: string;
  [key: string]: unknown;
};

export type KilllistResponse = { kills: KilllistItem[] };

export async function getKilllist(
  db: Db,
  params: Record<string, string | number>,
  ttlSeconds?: number,
): Promise<ApiResult<KilllistItem[]>> {
  const result = await cachedGet<KilllistResponse>(db, 'killlist', 'killlist', params, ttlSeconds ?? 120);
  if (!result.ok) return result;
  return { ok: true, data: result.data.kills ?? [] };
}

// ---------------------------------------------------------------------------
// Public API: Query (MongoDB-style — currently 404 on live API, kept as fallback)
// ---------------------------------------------------------------------------

export async function queryKillmails(db: Db, req: QueryRequest): Promise<ApiResult<QueryResponse>> {
  const cfg = getEveKillConfig();
  const capped: QueryRequest = {
    filter: req.filter,
    options: {
      ...req.options,
      limit: Math.min(req.options?.limit ?? 20, cfg.maxQueryLimit),
    },
  };
  const hashKey = JSON.stringify(capped);
  const ttl = cacheTtl(inferPastSecondsFromFilter(req.filter));
  return cachedPost(db, 'query', hashKey, 'query', capped, ttl);
}

function inferPastSecondsFromFilter(filter: Record<string, unknown>): number | undefined {
  const killTime = filter.kill_time as Record<string, unknown> | undefined;
  if (!killTime) return undefined;
  const gte = killTime.$gte ?? killTime.$gt;
  if (typeof gte === 'number') {
    return Math.max(0, Math.floor(Date.now() / 1000) - gte);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API: Characters / Corporations / Alliances
// ---------------------------------------------------------------------------

type EntityScope = 'characters' | 'corporations' | 'alliances';

export async function getEntityStats(
  db: Db, scope: EntityScope, id: number, days = 7,
): Promise<ApiResult<EntityStats>> {
  return cachedGet(db, `${scope}-stats`, `${scope}/${id}/stats`, { days }, 600);
}

export async function getEntityShortStats(
  db: Db, scope: EntityScope, id: number, days = 7,
): Promise<ApiResult<EntityStats>> {
  return cachedGet(db, `${scope}-sstats`, `${scope}/${id}/shortstats`, { days }, 600);
}

export async function getEntityTop(
  db: Db, scope: EntityScope, id: number, type: 'ships' | 'systems' | 'regions',
): Promise<ApiResult<TopEntry[]>> {
  return cachedGet(db, `${scope}-top`, `${scope}/${id}/top`, { type }, 600);
}

export async function getEntityBattles(
  db: Db, scope: EntityScope, id: number, page = 1, limit = 10,
): Promise<ApiResult<BattleSummary[]>> {
  return cachedGet(db, `${scope}-battles`, `${scope}/${id}/battles`, { page, limit }, 300);
}

export async function getCharacterCorpHistory(db: Db, id: number): Promise<ApiResult<unknown[]>> {
  return cachedGet(db, 'char-corphist', `characters/${id}/corporationhistory`, undefined, 3600);
}

export async function getCorpAllianceHistory(db: Db, id: number): Promise<ApiResult<unknown[]>> {
  return cachedGet(db, 'corp-allhist', `corporations/${id}/alliancehistory`, undefined, 3600);
}

export async function getEntityMembers(
  db: Db, scope: 'corporations' | 'alliances', id: number, page = 1, limit = 100,
): Promise<ApiResult<unknown[]>> {
  return cachedGet(db, `${scope}-members`, `${scope}/${id}/members`, { page, limit }, 600);
}

export async function getAllianceCoalition(db: Db, id: number): Promise<ApiResult<unknown[]>> {
  return cachedGet(db, 'alliance-coal', `alliances/${id}/coalition`, undefined, 3600);
}

// ---------------------------------------------------------------------------
// Public API: Battles
// ---------------------------------------------------------------------------

export async function listBattles(db: Db, page = 1, limit = 10): Promise<ApiResult<BattleSummary[]>> {
  return cachedGet(db, 'battles', 'battles', { page, limit }, 120);
}

export async function getBattle(db: Db, id: number | string, includeKillmails = false): Promise<ApiResult<unknown>> {
  return cachedGet(db, 'battle', `battles/${id}`, { includeKillmails: String(includeKillmails) }, 300);
}

// ---------------------------------------------------------------------------
// Public API: Prices
// ---------------------------------------------------------------------------

export async function getTypePrices(db: Db, typeId: number, days = 7): Promise<ApiResult<unknown>> {
  return cachedGet(db, 'prices-type', `prices/type_id/${typeId}`, { days }, 600);
}

export async function getBuildPrice(db: Db, typeId: number, days = 7): Promise<ApiResult<BuildPrice>> {
  return cachedGet(db, 'prices-build', `prices/type_id/${typeId}/buildPrice`, { days }, 600);
}

// ---------------------------------------------------------------------------
// Public API: Search
// ---------------------------------------------------------------------------

export async function search(db: Db, term: string): Promise<ApiResult<SearchResult>> {
  return cachedGet(db, 'search', `search/${encodeURIComponent(term)}`, undefined, 300);
}

// ---------------------------------------------------------------------------
// Public API: Global Stats
// ---------------------------------------------------------------------------

export async function getGlobalStats(
  db: Db, type: string, days = 7, limit = 10,
): Promise<ApiResult<unknown>> {
  return cachedGet(db, 'gstats', 'stats', { type, days, limit }, 300);
}
