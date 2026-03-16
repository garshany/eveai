import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { getAccessToken, getLinkedCharacter } from './sso.js';
import { loadEsiCatalog, type EsiOperationMeta } from './esi-catalog.js';

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
};

export async function callEsiOperation<T = unknown>(
  db: Db,
  operationName: string,
  args: Record<string, unknown>,
  chatId?: number | null,
): Promise<EsiCallResult<T>> {
  const catalog = await loadEsiCatalog();
  const operation = catalog.get(operationName);
  if (!operation) {
    return { ok: false, status: 404, error: `Unknown ESI operation: ${operationName}` };
  }

  const access = await resolveAccess(db, operation, chatId ?? undefined);
  if (!access.ok) {
    return { ok: false, status: access.status, error: access.error };
  }

  const prepared = prepareRequest(operation, args, access.characterId);
  if (!prepared.ok) {
    return { ok: false, status: 400, error: prepared.error };
  }

  const cacheKey = buildCacheKey(operation, prepared.url.toString(), access.characterId);
  if (operation.method === 'GET') {
    const cached = readCachedResponse<T>(db, cacheKey);
    if (cached) return cached;
  }

  const fetchResult = await fetchEsi<T>(prepared.url, operation, prepared.body, access.token);
  if (!fetchResult.ok) {
    return fetchResult;
  }

  if (operation.method === 'GET') {
    writeCachedResponse(db, cacheKey, JSON.stringify(fetchResult.data), fetchResult.headers.expires ?? null);
  }

  return fetchResult;
}

export async function canCallEsiOperation(
  db: Db,
  operationName: string,
  chatId?: number | null,
): Promise<boolean> {
  const catalog = await loadEsiCatalog();
  const operation = catalog.get(operationName);
  if (!operation) return false;
  const access = await resolveAccess(db, operation, chatId ?? undefined);
  return access.ok;
}

async function resolveAccess(
  db: Db,
  operation: EsiOperationMeta,
  chatId?: number,
): Promise<{ ok: true; token: string | null; characterId: number | null } | { ok: false; status: number; error: string }> {
  if (!operation.requiresAuth) {
    return { ok: true, token: null, characterId: getLinkedCharacter(db, chatId)?.characterId ?? null };
  }

  const linked = getLinkedCharacter(db, chatId);
  if (!linked) {
    return { ok: false, status: 401, error: 'No linked EVE character.' };
  }
  const missing = operation.requiredScopes.filter((scope) => !linked.scopes.includes(scope));
  if (missing.length > 0) {
    return { ok: false, status: 403, error: `Missing scopes: ${missing.join(', ')}` };
  }

  const token = await getAccessToken(db, chatId);
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
  url: URL,
  operation: EsiOperationMeta,
  body: string | null,
  token: string | null,
): Promise<EsiCallResult<T>> {
  const headers = new Headers({
    Accept: 'application/json',
    'User-Agent': 'eve-agent/0.1.0',
    'X-Compatibility-Date': config.esi.compatibilityDate,
  });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body) headers.set('Content-Type', 'application/json');

  const pageData: unknown[] = [];
  let page = 1;
  let lastHeaders: Record<string, string> = {};

  while (true) {
    const pageUrl = new URL(url.toString());
    if (operation.paginationType === 'x-pages' && operation.hiddenPageParam) {
      pageUrl.searchParams.set('page', String(page));
    }

    const response = await fetch(pageUrl, {
      method: operation.method,
      headers,
      body,
    });
    const responseHeaders = headersToRecord(response.headers);
    lastHeaders = responseHeaders;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: await parseError(response),
        headers: responseHeaders,
      };
    }

    const payload = response.status === 204
      ? null
      : await response.json().catch(async () => await response.text());
    if (operation.paginationType !== 'x-pages' || !operation.hiddenPageParam || !Array.isArray(payload)) {
      return {
        ok: true,
        status: response.status,
        data: payload as T,
        cached: false,
        headers: responseHeaders,
      };
    }

    pageData.push(...payload);
    const totalPages = Number(response.headers.get('x-pages') ?? '1');
    if (!Number.isFinite(totalPages) || page >= Math.min(totalPages, config.esi.maxPages)) {
      return {
        ok: true,
        status: response.status,
        data: pageData as T,
        cached: false,
        headers: lastHeaders,
      };
    }
    page += 1;
  }
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

function readCachedResponse<T>(db: Db, cacheKey: string): EsiCallResult<T> | null {
  const row = db.prepare(
    'SELECT response_text, expires_at FROM esi_cache WHERE cache_key = ? AND expires_at > datetime(\'now\')'
  ).get(cacheKey) as EsiCacheRow | undefined;
  if (!row) return null;
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

function writeCachedResponse(db: Db, cacheKey: string, responseText: string, expiresHeader: string | null): void {
  const expiresAt = normalizeExpires(expiresHeader);
  db.prepare(`
    INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(cache_key) DO UPDATE SET
      response_text = excluded.response_text,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).run(cacheKey, responseText, expiresAt);
}

function normalizeExpires(expiresHeader: string | null): string {
  if (expiresHeader) {
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
