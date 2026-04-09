/**
 * EVE-Scout public API client with DB-backed caching.
 *
 * Endpoints:
 *   /v2/public/routes           — WH-aware A→B routing
 *   /v2/public/routes/highsec   — closest highsec exits
 *   /v2/public/routes/joveobservatories — nearest Jove Obs
 *   /v2/public/routes/signatures — routes to all active WHs
 *   /v2/public/signatures       — Thera/Turnur WH connections
 *   /v2/public/observations     — metaliminal storms & oddities
 *   /v2/public/wormholetypes    — WH type encyclopedia
 *   /v2/public/systems          — system search with class filter
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { fetchRetrying } from './http.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EveScoutRouteSystem = {
  system_id: number;
  system_name: string;
  region_id: number;
  region_name: string;
  system_class: string;
  security_status: number;
  jove_observatory?: boolean;
};

export type EveScoutRoute = {
  from: string;
  to: string;
  jumps: number;
  signature_id?: number;
  route: EveScoutRouteSystem[];
};

export type EveScoutSignature = {
  id: string;
  completed: boolean;
  wh_type: string;
  max_ship_size: string;
  expires_at: string;
  remaining_hours: number;
  in_system_id: number;
  in_system_name: string;
  in_system_class: string;
  in_region_name: string;
  out_system_id: number;
  out_system_name: string;
  in_signature: string;
  out_signature: string;
  signature_type?: string;
  comment?: string;
  wh_exits_outward?: boolean;
  in_region_id?: number;
};

export type EveScoutObservation = {
  id: string;
  created_at: string;
  created_by_id: number;
  created_by_name: string;
  observed_in_person: boolean;
  observation_type: string;
  observation_category: string;
  display_name: string;
  hours_in_system: number;
  system_id: number;
  system_name: string;
  region_id: number;
  region_name: string;
};

export type EveScoutWormholeType = {
  identifier: string;
  type_id: number;
  max_jump_mass: number;
  max_stable_mass: number;
  max_stable_time: number;
  mass_regeneration: number;
  source: string[];
  target_system_class: string;
  possible_static: boolean;
  wandering_only: boolean;
  comment_public: string;
  signature_level: number[];
};

export type EveScoutSystem = {
  system_id: number;
  system_name: string;
  system_class: string;
  region_id: number;
  region_name: string;
  security_status: number;
  jove_observatory?: boolean;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getConfig() {
  return config.eveScout;
}

function retryOpts() {
  const cfg = getConfig();
  return { maxAttempts: cfg.retryMaxAttempts, backoffMaxMs: cfg.backoffMaxMs, timeoutMs: cfg.timeoutMs };
}

// ---------------------------------------------------------------------------
// Core HTTP
// ---------------------------------------------------------------------------

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

async function apiGet<T>(path: string, params?: Record<string, string | number>): Promise<ApiResult<T>> {
  const cfg = getConfig();
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
    }, retryOpts());
    if (!res.ok) {
      console.warn('[eve-scout] GET %s -> %d', path, res.status);
      return { ok: false, error: `EVE-Scout HTTP ${res.status}`, status: res.status };
    }
    const data = await res.json() as T;
    return { ok: true, data };
  } catch (err) {
    console.warn('[eve-scout] GET %s failed: %s', path, (err as Error).message);
    return { ok: false, error: `EVE-Scout request failed: ${(err as Error).message}` };
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const cfg = getConfig();
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
    }, retryOpts());
    if (!res.ok) {
      console.warn('[eve-scout] POST %s -> %d', path, res.status);
      return { ok: false, error: `EVE-Scout HTTP ${res.status}`, status: res.status };
    }
    const data = await res.json() as T;
    return { ok: true, data };
  } catch (err) {
    console.warn('[eve-scout] POST %s failed: %s', path, (err as Error).message);
    return { ok: false, error: `EVE-Scout request failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Cache (reuses esi_cache table)
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

async function cachedGet<T>(
  db: Db,
  cachePrefix: string,
  path: string,
  params?: Record<string, string | number>,
  ttlSeconds?: number,
): Promise<ApiResult<T>> {
  const paramStr = params ? Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&') : '';
  const cacheKey = `evescout:${cachePrefix}:${path}:${paramStr}`;
  const cached = readCache<T>(db, cacheKey);
  if (cached !== null) return { ok: true, data: cached };

  const result = await apiGet<T>(path, params);
  if (result.ok) {
    writeCache(db, cacheKey, result.data, ttlSeconds ?? getConfig().cacheTtlSeconds);
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
  const cacheKey = `evescout:${cachePrefix}:${cacheIdentifier}`;
  const cached = readCache<T>(db, cacheKey);
  if (cached !== null) return { ok: true, data: cached };

  const result = await apiPost<T>(path, body);
  if (result.ok) {
    writeCache(db, cacheKey, result.data, ttlSeconds ?? getConfig().cacheTtlSeconds);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API: Routes
// ---------------------------------------------------------------------------

export async function getRoute(
  db: Db,
  from: string,
  to: string,
  preference?: string,
): Promise<ApiResult<EveScoutRoute[]>> {
  const params: Record<string, string> = { from, to };
  if (preference) params.preference = preference;
  return cachedGet(db, 'route', 'routes', params, 300);
}

export async function getMultiRoute(
  db: Db,
  from: string,
  destinations: string[],
  preference?: string,
): Promise<ApiResult<EveScoutRoute[]>> {
  const body: Record<string, unknown> = { from, to: destinations };
  if (preference) body.preference = preference;
  const hashKey = `${from}:${destinations.slice().sort().join(',')}:${preference ?? 'safer'}`;
  return cachedPost(db, 'multi-route', hashKey, 'routes', body, 300);
}

export async function getClosestHighsec(
  db: Db,
  from: string,
): Promise<ApiResult<EveScoutRoute[]>> {
  return cachedGet(db, 'highsec', 'routes/highsec', { from }, 300);
}

export async function getJoveRoutes(
  db: Db,
  from: string,
  preference?: string,
): Promise<ApiResult<EveScoutRoute[]>> {
  const params: Record<string, string> = { from };
  if (preference) params.preference = preference;
  return cachedGet(db, 'jove', 'routes/joveobservatories', params, 300);
}

export async function getSignatureRoutes(
  db: Db,
  from: string,
  preference?: string,
): Promise<ApiResult<EveScoutRoute[]>> {
  const params: Record<string, string> = { from };
  if (preference) params.preference = preference;
  return cachedGet(db, 'sig-routes', 'routes/signatures', params, 300);
}

// ---------------------------------------------------------------------------
// Public API: Signatures
// ---------------------------------------------------------------------------

export async function getSignatures(
  db: Db,
): Promise<ApiResult<EveScoutSignature[]>> {
  return cachedGet(db, 'sigs', 'signatures', undefined, 300);
}

// ---------------------------------------------------------------------------
// Public API: Observations
// ---------------------------------------------------------------------------

export async function getObservations(
  db: Db,
): Promise<ApiResult<EveScoutObservation[]>> {
  return cachedGet(db, 'obs', 'observations', undefined, 3600);
}

// ---------------------------------------------------------------------------
// Public API: Wormhole Types
// ---------------------------------------------------------------------------

export async function getWormholeTypes(
  db: Db,
  filters?: { identifier?: string; source?: string; target?: string },
): Promise<ApiResult<EveScoutWormholeType[]>> {
  const params: Record<string, string> = {};
  if (filters?.identifier) params.identifier = filters.identifier;
  if (filters?.source) params.source = filters.source;
  if (filters?.target) params.target = filters.target;
  return cachedGet(db, 'wh-types', 'wormholetypes', Object.keys(params).length > 0 ? params : undefined, 86400);
}

// ---------------------------------------------------------------------------
// Public API: Systems
// ---------------------------------------------------------------------------

export async function searchSystems(
  db: Db,
  query: string,
  space?: string,
  limit?: number,
): Promise<ApiResult<EveScoutSystem[]>> {
  const params: Record<string, string | number> = { string: query };
  if (space) params.space = space;
  if (limit) params.limit = limit;
  return cachedGet(db, 'systems', 'systems', params, 86400);
}
