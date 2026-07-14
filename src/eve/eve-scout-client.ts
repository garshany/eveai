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

export type EveScoutDataFreshness = {
  /** Safe, model-facing observation marker; never contains transport headers. */
  dataThrough: string | null;
  cacheMaxAgeSeconds: number;
  cacheHit: boolean;
};

export type EveScoutSystemSpace = 'k-space' | 'j-space';

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

export type EveScoutApiResult<T> =
  | { ok: true; data: T; freshness: EveScoutDataFreshness }
  | { ok: false; error: string; status?: number };

async function apiGet<T>(path: string, params?: Record<string, string | number>): Promise<EveScoutApiResult<T>> {
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
    return {
      ok: true,
      data,
      freshness: {
        dataThrough: normalizeHttpDate(res.headers.get('date')),
        cacheMaxAgeSeconds: parseCacheMaxAge(res.headers.get('cache-control')) ?? getConfig().cacheTtlSeconds,
        cacheHit: false,
      },
    };
  } catch (err) {
    console.warn('[eve-scout] GET %s failed: %s', path, (err as Error).message);
    return { ok: false, error: `EVE-Scout request failed: ${(err as Error).message}` };
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<EveScoutApiResult<T>> {
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
    return {
      ok: true,
      data,
      freshness: {
        dataThrough: normalizeHttpDate(res.headers.get('date')),
        cacheMaxAgeSeconds: parseCacheMaxAge(res.headers.get('cache-control')) ?? getConfig().cacheTtlSeconds,
        cacheHit: false,
      },
    };
  } catch (err) {
    console.warn('[eve-scout] POST %s failed: %s', path, (err as Error).message);
    return { ok: false, error: `EVE-Scout request failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Cache (reuses esi_cache table)
// ---------------------------------------------------------------------------

function readCache<T>(db: Db, key: string): { data: T; createdAt: string | null } | null {
  const row = db.prepare(
    "SELECT response_text, created_at FROM esi_cache WHERE cache_key = ? AND expires_at > datetime('now')",
  ).get(key) as { response_text: string; created_at: string } | undefined;
  if (!row) return null;
  try {
    return { data: JSON.parse(row.response_text) as T, createdAt: sqliteTimeToIso(row.created_at) };
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
): Promise<EveScoutApiResult<T>> {
  const paramStr = params ? Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&') : '';
  const cacheKey = `evescout:${cachePrefix}:${path}:${paramStr}`;
  const cached = readCache<T>(db, cacheKey);
  const maxAgeSeconds = ttlSeconds ?? getConfig().cacheTtlSeconds;
  if (cached !== null) {
    return {
      ok: true,
      data: cached.data,
      freshness: { dataThrough: cached.createdAt, cacheMaxAgeSeconds: maxAgeSeconds, cacheHit: true },
    };
  }

  const result = await apiGet<T>(path, params);
  if (result.ok) {
    writeCache(db, cacheKey, result.data, maxAgeSeconds);
    result.freshness.cacheMaxAgeSeconds = maxAgeSeconds;
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
): Promise<EveScoutApiResult<T>> {
  const cacheKey = `evescout:${cachePrefix}:${cacheIdentifier}`;
  const cached = readCache<T>(db, cacheKey);
  const maxAgeSeconds = ttlSeconds ?? getConfig().cacheTtlSeconds;
  if (cached !== null) {
    return {
      ok: true,
      data: cached.data,
      freshness: { dataThrough: cached.createdAt, cacheMaxAgeSeconds: maxAgeSeconds, cacheHit: true },
    };
  }

  const result = await apiPost<T>(path, body);
  if (result.ok) {
    writeCache(db, cacheKey, result.data, maxAgeSeconds);
    result.freshness.cacheMaxAgeSeconds = maxAgeSeconds;
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
): Promise<EveScoutApiResult<EveScoutRoute[]>> {
  const params: Record<string, string> = { from, to };
  if (preference) params.preference = preference;
  return cachedGet(db, 'route', 'routes', params, 300);
}

export async function getMultiRoute(
  db: Db,
  from: string,
  destinations: string[],
  preference?: string,
): Promise<EveScoutApiResult<EveScoutRoute[]>> {
  const body: Record<string, unknown> = { from, to: destinations };
  if (preference) body.preference = preference;
  const hashKey = `${from}:${destinations.slice().sort().join(',')}:${preference ?? 'safer'}`;
  return cachedPost(db, 'multi-route', hashKey, 'routes', body, 300);
}

export async function getClosestHighsec(
  db: Db,
  from: string,
): Promise<EveScoutApiResult<EveScoutRoute[]>> {
  return cachedGet(db, 'highsec', 'routes/highsec', { from }, 300);
}

export async function getJoveRoutes(
  db: Db,
  from: string,
  preference?: string,
): Promise<EveScoutApiResult<EveScoutRoute[]>> {
  const params: Record<string, string> = { from };
  if (preference) params.preference = preference;
  return cachedGet(db, 'jove', 'routes/joveobservatories', params, 300);
}

export async function getSignatureRoutes(
  db: Db,
  from: string,
  preference?: string,
): Promise<EveScoutApiResult<EveScoutRoute[]>> {
  const params: Record<string, string> = { from };
  if (preference) params.preference = preference;
  return cachedGet(db, 'sig-routes', 'routes/signatures', params, 300);
}

// ---------------------------------------------------------------------------
// Public API: Signatures
// ---------------------------------------------------------------------------

export async function getSignatures(
  db: Db,
): Promise<EveScoutApiResult<EveScoutSignature[]>> {
  return cachedGet(db, 'sigs', 'signatures', undefined, 300);
}

// ---------------------------------------------------------------------------
// Public API: Observations
// ---------------------------------------------------------------------------

export async function getObservations(
  db: Db,
): Promise<EveScoutApiResult<EveScoutObservation[]>> {
  return cachedGet(db, 'obs', 'observations', undefined, 3600);
}

// ---------------------------------------------------------------------------
// Public API: Wormhole Types
// ---------------------------------------------------------------------------

export async function getWormholeTypes(
  db: Db,
  filters?: { identifier?: string; source?: string; target?: string },
): Promise<EveScoutApiResult<EveScoutWormholeType[]>> {
  const params: Record<string, string> = {};
  if (filters?.identifier) params.identifier = filters.identifier;
  if (filters?.source) params.source = filters.source;
  if (filters?.target) params.target = filters.target;
  const result = await cachedGet<unknown>(
    db,
    'wh-types',
    'wormholetypes',
    Object.keys(params).length > 0 ? params : undefined,
    86400,
  );
  if (!result.ok) return result;
  const validated = validateWormholeTypesPayload(result.data);
  if (!validated) {
    return { ok: false, error: 'EVE-Scout returned an invalid wormhole types payload', status: 502 };
  }
  return { ok: true, data: validated, freshness: result.freshness };
}

// ---------------------------------------------------------------------------
// Public API: Systems
// ---------------------------------------------------------------------------

export async function searchSystems(
  db: Db,
  query: string,
  space?: EveScoutSystemSpace,
  limit?: number,
): Promise<EveScoutApiResult<EveScoutSystem[]>> {
  const params: Record<string, string | number> = { query };
  if (space) params.space = space;
  if (limit) params.limit = limit;
  const result = await cachedGet<unknown>(db, 'systems', 'systems', params, 86400);
  if (!result.ok) return result;
  const validated = validateSystemsPayload(result.data);
  if (!validated) {
    return { ok: false, error: 'EVE-Scout returned an invalid systems payload', status: 502 };
  }
  return { ok: true, data: validated, freshness: result.freshness };
}

function normalizeHttpDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sqliteTimeToIso(value: string): string | null {
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseCacheMaxAge(value: string | null): number | null {
  const match = value?.match(/(?:^|,)\s*max-age=(\d+)\b/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validateSystemsPayload(payload: unknown): EveScoutSystem[] | null {
  if (!Array.isArray(payload)) return null;
  const systems: EveScoutSystem[] = [];
  for (const value of payload) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.system_id)
      || typeof row.system_name !== 'string'
      || typeof row.system_class !== 'string'
      || !Number.isSafeInteger(row.region_id)
      || typeof row.region_name !== 'string'
      || typeof row.security_status !== 'number'
      || !Number.isFinite(row.security_status)
      || (row.jove_observatory !== undefined && typeof row.jove_observatory !== 'boolean')
    ) return null;
    systems.push({
      system_id: row.system_id as number,
      system_name: row.system_name,
      system_class: row.system_class,
      region_id: row.region_id as number,
      region_name: row.region_name,
      security_status: row.security_status,
      ...(typeof row.jove_observatory === 'boolean' ? { jove_observatory: row.jove_observatory } : {}),
    });
  }
  return systems;
}

function validateWormholeTypesPayload(payload: unknown): EveScoutWormholeType[] | null {
  if (!Array.isArray(payload)) return null;
  const wormholeTypes: EveScoutWormholeType[] = [];
  for (const value of payload) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.identifier !== 'string'
      || !Number.isSafeInteger(row.type_id)
      || !isFiniteNumber(row.max_jump_mass)
      || !isFiniteNumber(row.max_stable_mass)
      || !Number.isSafeInteger(row.max_stable_time)
      || !isFiniteNumber(row.mass_regeneration)
      || !Array.isArray(row.source)
      || !row.source.every((entry) => typeof entry === 'string')
      || typeof row.target_system_class !== 'string'
      || typeof row.possible_static !== 'boolean'
      || typeof row.wandering_only !== 'boolean'
      || typeof row.comment_public !== 'string'
      || !Array.isArray(row.signature_level)
      || !row.signature_level.every(isFiniteNumber)
    ) return null;
    wormholeTypes.push({
      identifier: row.identifier,
      type_id: row.type_id as number,
      max_jump_mass: row.max_jump_mass,
      max_stable_mass: row.max_stable_mass,
      max_stable_time: row.max_stable_time as number,
      mass_regeneration: row.mass_regeneration,
      source: row.source as string[],
      target_system_class: row.target_system_class,
      possible_static: row.possible_static,
      wandering_only: row.wandering_only,
      comment_public: row.comment_public,
      signature_level: row.signature_level as number[],
    });
  }
  return wormholeTypes;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
