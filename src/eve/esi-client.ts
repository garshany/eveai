import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { getAccessToken, getLinkedCharacter } from './sso.js';
import { loadEsiCatalog, type EsiOperationMeta } from './esi-catalog.js';
import { hasFreshCapabilitySnapshot } from './capabilities.js';
import type { UserContext } from '../auth/user-resolver.js';
import { fetchWithTimeout, parseHeaderInt, parseRetryAfterMs, sleep } from './http.js';

export type EsiCallResult<T = unknown> =
  | {
      ok: true;
      status: number;
      data: T;
      cached: boolean;
      headers: Record<string, string>;
    }
  | {
      ok: false;
      status: number;
      error: string;
      headers?: Record<string, string>;
    };

type EsiCacheRow = {
  response_text: string;
  expires_at: string;
  etag: string | null;
  last_modified: string | null;
};

export async function callEsiOperation<T = unknown>(
  db: Db,
  operationName: string,
  args: Record<string, unknown>,
  ctx?: UserContext | number | null,
): Promise<EsiCallResult<T>> {
  const userCtx = normalizeCtx(ctx);
  const catalog = await loadEsiCatalog();
  const operation = catalog.get(operationName);
  if (!operation) {
    return { ok: false, status: 404, error: `Unknown ESI operation: ${operationName}` };
  }

  const access = await resolveAccess(db, operation, userCtx);
  if (!access.ok) {
    return { ok: false, status: access.status, error: access.error };
  }

  const prepared = prepareRequest(operation, args, access.characterId);
  if (!prepared.ok) {
    return { ok: false, status: 400, error: prepared.error };
  }

  const cacheKey = buildCacheKey(operation, prepared.url.toString(), access.characterId);
  const cacheRow = operation.method === 'GET' ? readCacheRow(db, cacheKey) : null;
  if (operation.method === 'GET') {
    const cached = readFreshCachedResponse<T>(cacheRow);
    if (cached) return cached;
  }

  const fetchResult = await fetchEsi<T>(db, cacheKey, cacheRow, prepared.url, operation, prepared.body, access.token);
  if (!fetchResult.ok) {
    return fetchResult;
  }

  return fetchResult;
}

export async function canCallEsiOperation(
  db: Db,
  operationName: string,
  ctx?: UserContext | number | null,
): Promise<boolean> {
  const userCtx = normalizeCtx(ctx);
  const catalog = await loadEsiCatalog();
  const operation = catalog.get(operationName);
  if (!operation) return false;
  const access = await resolveAccess(db, operation, userCtx);
  return access.ok;
}

function normalizeCtx(ctx?: UserContext | number | null): UserContext {
  if (!ctx) return { userId: 0 };
  if (typeof ctx === 'number') return { userId: 0, chatId: ctx };
  return ctx;
}

async function resolveAccess(
  db: Db,
  operation: EsiOperationMeta,
  ctx: UserContext,
): Promise<{ ok: true; token: string | null; characterId: number | null } | { ok: false; status: number; error: string }> {
  if (!operation.requiresAuth) {
    return { ok: true, token: null, characterId: getLinkedCharacter(db, ctx)?.characterId ?? null };
  }

  const linked = getLinkedCharacter(db, ctx);
  if (!linked) {
    return { ok: false, status: 401, error: 'No linked EVE character.' };
  }
  if (!hasFreshCapabilitySnapshot(ctx, linked.characterId)) {
    return {
      ok: false,
      status: 428,
      error: 'Private ESI access requires a fresh get_eve_capabilities check first.',
    };
  }
  const missing = operation.requiredScopes.filter((scope) => !linked.scopes.includes(scope));
  if (missing.length > 0) {
    return { ok: false, status: 403, error: `Missing scopes: ${missing.join(', ')}` };
  }

  const token = await getAccessToken(db, ctx);
  if (!token) {
    return { ok: false, status: 401, error: 'No valid EVE access token.' };
  }
  return { ok: true, token: token.token, characterId: token.characterId };
}

function prepareRequest(
  operation: EsiOperationMeta,
  args: Record<string, unknown>,
  boundCharacterId: number | null,
): { ok: true; url: URL; body: string | null } | { ok: false; error: string } {
  let path = operation.path;
  const url = buildEsiUrl(config.esi.baseUrl, path);
  let body: string | null = null;

  for (const parameter of operation.parameters) {
    const rawValue = parameter.name === 'character_id' && boundCharacterId
      ? boundCharacterId
      : args[parameter.name];
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      if (parameter.required) {
        return { ok: false, error: `Missing required parameter: ${parameter.name}` };
      }
      continue;
    }
    const value = serializeParamValue(rawValue, parameter.collectionFormat);
    if (parameter.in === 'path') {
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
      url.pathname = buildEsiUrl(config.esi.baseUrl, path).pathname;
    } else if (parameter.in === 'query') {
      url.searchParams.set(parameter.name, value);
    } else if (parameter.in === 'header') {
      // model does not control headers directly
    }
  }

  if (operation.bodyParameter) {
    const rawBody = args[operation.bodyParameter.name];
    if (typeof rawBody === 'string' && rawBody.trim()) {
      body = rawBody;
      try {
        JSON.parse(rawBody);
      } catch (err) {
        return { ok: false, error: `Invalid JSON body for ${operation.bodyParameter.name}: ${(err as Error).message}` };
      }
    } else if (operation.bodyParameter.required) {
      return { ok: false, error: `Missing request body: ${operation.bodyParameter.name}` };
    }
  }

  return { ok: true, url, body };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function buildEsiUrl(baseUrl: string, path: string): URL {
  const url = new URL(normalizeBaseUrl(baseUrl));
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  const relativePath = path.replace(/^\/+/, '');
  url.pathname = `${basePath}${relativePath}`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url;
}

function serializeParamValue(value: unknown, collectionFormat: string | null): string {
  if (Array.isArray(value)) {
    const separator = collectionFormat === 'pipes' ? '|'
      : collectionFormat === 'ssv' ? ' '
        : collectionFormat === 'tsv' ? '\t'
          : ',';
    return value.map((item) => serializeParamValue(item, null)).join(separator);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

async function fetchEsi<T>(
  db: Db,
  cacheKey: string,
  cacheRow: EsiCacheRow | null,
  url: URL,
  operation: EsiOperationMeta,
  body: string | null,
  token: string | null,
): Promise<EsiCallResult<T>> {
  const headers = new Headers({
    Accept: 'application/json',
    'User-Agent': config.esi.userAgent,
    'X-Compatibility-Date': config.esi.compatibilityDate,
  });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body) headers.set('Content-Type', 'application/json');

  const pageData: unknown[] = [];
  let page = 1;
  let lastHeaders: Record<string, string> = {};
  let firstPageSnapshot: { etag: string | null; lastModified: string | null } | null = null;

  while (true) {
    const pageUrl = new URL(url.toString());
    if (operation.paginationType === 'x-pages' && operation.hiddenPageParam) {
      pageUrl.searchParams.set('page', String(page));
    }
    if (cacheRow?.etag && operation.method === 'GET' && operation.paginationType === 'none') {
      headers.set('If-None-Match', cacheRow.etag);
    }
    if (!cacheRow?.etag && cacheRow?.last_modified && operation.method === 'GET' && operation.paginationType === 'none') {
      headers.set('If-Modified-Since', cacheRow.last_modified);
    }

    const response = await fetchEsiWithRetry(pageUrl, operation, headers, body);
    if (!response.ok) {
      return response.result;
    }
    const { value } = response;
    const responseHeaders = headersToRecord(value.headers);
    lastHeaders = responseHeaders;
    if (value.status === 304) {
      const cached = revalidateCachedResponse<T>(db, cacheKey, cacheRow, responseHeaders);
      if (cached) return cached;
      return {
        ok: false,
        status: 502,
        error: 'ESI returned 304 but no cached payload was available.',
        headers: responseHeaders,
      };
    }

    const payload = value.status === 204
      ? null
      : await value.json().catch(async () => await value.text());
    if (operation.paginationType !== 'x-pages' || !operation.hiddenPageParam || !Array.isArray(payload)) {
      if (operation.method === 'GET') {
        writeCachedResponse(db, cacheKey, JSON.stringify(payload), responseHeaders);
      }
      return {
        ok: true,
        status: value.status,
        data: payload as T,
        cached: false,
        headers: responseHeaders,
      };
    }

    const pageSnapshot = {
      etag: value.headers.get('etag'),
      lastModified: value.headers.get('last-modified'),
    };
    if (!firstPageSnapshot) {
      firstPageSnapshot = pageSnapshot;
    } else if (!matchesSnapshot(firstPageSnapshot, pageSnapshot)) {
      return {
        ok: false,
        status: 409,
        error: 'ESI paginated response changed during collection; retry later.',
        headers: responseHeaders,
      };
    }

    pageData.push(...payload);
    const totalPages = Number(value.headers.get('x-pages') ?? '1');
    if (Number.isFinite(totalPages) && totalPages > config.esi.maxPages) {
      return {
        ok: false,
        status: 422,
        error: `ESI pagination requires ${totalPages} pages, exceeds configured ESI_MAX_PAGES=${config.esi.maxPages}.`,
        headers: responseHeaders,
      };
    }
    if (!Number.isFinite(totalPages) || page >= totalPages) {
      writeCachedResponse(db, cacheKey, JSON.stringify(pageData), lastHeaders);
      return {
        ok: true,
        status: value.status,
        data: pageData as T,
        cached: false,
        headers: lastHeaders,
      };
    }
    await throttleIfNeeded(value.headers);
    page += 1;
  }
}

async function fetchEsiWithRetry(
  url: URL,
  operation: EsiOperationMeta,
  headers: Headers,
  body: string | null,
): Promise<{ ok: true; value: Response } | { ok: false; result: EsiCallResult<never> }> {
  const maxAttempts = Math.max(1, config.esi.retryMaxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: operation.method,
        headers,
        body,
      }, config.esi.requestTimeoutMs);
    } catch (error) {
      if (attempt < maxAttempts) {
        await sleep(computeBackoffMs(new Headers(), attempt));
        continue;
      }
      return {
        ok: false,
        result: {
          ok: false,
          status: 504,
          error: `ESI request failed: ${(error as Error).message}`,
        },
      };
    }

    if (response.ok || response.status === 304) {
      return { ok: true, value: response };
    }

    const shouldRetry = response.status === 420 || response.status === 429 || response.status >= 500;
    if (shouldRetry && attempt < maxAttempts) {
      await sleep(computeBackoffMs(response.headers, attempt));
      continue;
    }

    const responseHeaders = headersToRecord(response.headers);
    return {
      ok: false,
      result: {
        ok: false,
        status: response.status,
        error: await parseError(response),
        headers: responseHeaders,
      },
    };
  }

  return {
    ok: false,
    result: {
      ok: false,
      status: 504,
      error: 'ESI request exhausted all retry attempts.',
    },
  };
}

async function parseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error ?? text;
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

function buildCacheKey(operation: EsiOperationMeta, url: string, characterId: number | null): string {
  return `${operation.name}:${characterId ?? 0}:${url}`;
}

function readCacheRow(db: Db, cacheKey: string): EsiCacheRow | null {
  const row = db.prepare(
    'SELECT response_text, expires_at, etag, last_modified FROM esi_cache WHERE cache_key = ?'
  ).get(cacheKey) as EsiCacheRow | undefined;
  return row ?? null;
}

function readFreshCachedResponse<T>(row: EsiCacheRow | null): EsiCallResult<T> | null {
  if (!row || !isCacheFresh(row.expires_at)) return null;
  try {
    return {
      ok: true,
      status: 200,
      data: JSON.parse(row.response_text) as T,
      cached: true,
      headers: { expires: row.expires_at },
    };
  } catch {
    return null;
  }
}

function revalidateCachedResponse<T>(
  db: Db,
  cacheKey: string,
  row: EsiCacheRow | null,
  headers: Record<string, string>,
): EsiCallResult<T> | null {
  if (!row) return null;
  const cached = readFreshCachedResponse<T>({
    ...row,
    expires_at: normalizeExpires(headers.expires ?? row.expires_at),
  });
  if (!cached) return null;
  writeCachedResponse(db, cacheKey, row.response_text, {
    expires: headers.expires ?? row.expires_at,
    etag: headers.etag ?? row.etag,
    'last-modified': headers['last-modified'] ?? row.last_modified,
  });
  return {
    ...cached,
    headers: {
      ...cached.headers,
      ...headers,
    },
  };
}

function writeCachedResponse(db: Db, cacheKey: string, responseText: string, headers: Record<string, string>): void {
  const expiresAt = normalizeExpires(headers.expires ?? null);
  db.prepare(`
    INSERT INTO esi_cache (cache_key, response_text, etag, last_modified, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cache_key) DO UPDATE SET
      response_text = excluded.response_text,
      etag = excluded.etag,
      last_modified = excluded.last_modified,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).run(cacheKey, responseText, headers.etag ?? null, headers['last-modified'] ?? null, expiresAt);
}

function isCacheFresh(expiresAt: string): boolean {
  return Date.parse(expiresAt.replace(' ', 'T') + 'Z') > Date.now();
}

function matchesSnapshot(
  previous: { etag: string | null; lastModified: string | null },
  current: { etag: string | null; lastModified: string | null },
): boolean {
  if (previous.lastModified && current.lastModified) {
    return previous.lastModified === current.lastModified;
  }
  return true;
}

function computeBackoffMs(headers: Headers, attempt: number): number {
  const maxMs = Math.max(1000, config.esi.backoffMaxSeconds * 1000);
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'), 0);
  const ratelimitResetMs = headerSecondsToMs(headers, 'x-ratelimit-reset');
  const errorLimitResetMs = headerSecondsToMs(headers, 'x-esi-error-limit-reset');
  const exponentialMs = Math.min(maxMs, 1000 * (2 ** (attempt - 1)));
  const baseMs = Math.max(exponentialMs, retryAfterMs, ratelimitResetMs, errorLimitResetMs);
  const jitterMs = Math.min(250, baseMs / 4);
  return Math.min(maxMs, Math.round(baseMs + Math.random() * jitterMs));
}

async function throttleIfNeeded(headers: Headers): Promise<void> {
  const remaining = parseHeaderInt(headers, 'x-ratelimit-remaining');
  const errorRemain = parseHeaderInt(headers, 'x-esi-error-limit-remain');
  if ((remaining !== null && remaining <= 1) || (errorRemain !== null && errorRemain <= 1)) {
    await sleep(computeBackoffMs(headers, 1));
  }
}

function headerSecondsToMs(headers: Headers, name: string): number {
  const seconds = parseHeaderInt(headers, name);
  if (seconds === null || seconds < 0) return 0;
  return seconds * 1000;
}

function normalizeExpires(expiresHeader: string | null): string {
  if (expiresHeader) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(expiresHeader)) {
      return expiresHeader;
    }
    const date = new Date(expiresHeader);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().replace('T', ' ').slice(0, 19);
    }
  }
  const fallback = new Date(Date.now() + 60_000);
  return fallback.toISOString().replace('T', ' ').slice(0, 19);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}
