import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

export type WebSearchSource = 'eve_uni' | 'esi_docs' | 'general' | 'openai' | 'all';

export interface WebSearchRequest {
  query: string;
  source: WebSearchSource;
  limit: number;
}

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebSearchResult {
  ok: boolean;
  source: WebSearchSource;
  results: WebSearchItem[];
  error: string | null;
}

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESULTS = 10;
const SUPPORTED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

let esiSpecCache: { loadedAt: number; data: Record<string, unknown> } | null = null;

export async function webSearch(req: WebSearchRequest): Promise<WebSearchResult> {
  const query = req.query.trim();
  if (!query) {
    return { ok: false, source: req.source, results: [], error: 'Query is required' };
  }

  const configuredMax = clampNumber(config.webSearch?.maxResults ?? DEFAULT_MAX_RESULTS, 1, MAX_RESULTS, DEFAULT_MAX_RESULTS);
  const limit = clampNumber(req.limit, 1, configuredMax, DEFAULT_MAX_RESULTS);
  const timeoutMs = clampNumber(config.webSearch?.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 20000, DEFAULT_TIMEOUT_MS);
  const results: WebSearchItem[] = [];
  const errors: string[] = [];

  const wantsEveUni = req.source === 'eve_uni' || req.source === 'all';
  const wantsEsiDocs = req.source === 'esi_docs' || req.source === 'all';
  const wantsGeneral = req.source === 'general' || req.source === 'all';
  const wantsOpenAi = req.source === 'openai' || req.source === 'all';

  if (wantsEveUni) {
    try {
      const eveUniResults = await searchEveUni(query, limit, timeoutMs);
      results.push(...eveUniResults);
    } catch (err) {
      errors.push(`eve_uni: ${(err as Error).message}`);
    }
  }

  if (wantsEsiDocs) {
    try {
      const esiResults = await searchEsiDocs(query, limit, timeoutMs);
      results.push(...esiResults);
    } catch (err) {
      errors.push(`esi_docs: ${(err as Error).message}`);
    }
  }

  if (wantsOpenAi) {
    try {
      const openaiResults = await searchOpenAiWeb(query, limit);
      results.push(...openaiResults);
    } catch (err) {
      errors.push(`openai: ${(err as Error).message}`);
    }
  }

  if (wantsGeneral) {
    try {
      const wikiResults = await searchWikipedia(query, limit, timeoutMs);
      results.push(...wikiResults);
    } catch (err) {
      errors.push(`general(wikipedia): ${(err as Error).message}`);
    }
    try {
      const soResults = await searchStackOverflow(query, limit, timeoutMs);
      results.push(...soResults);
    } catch (err) {
      errors.push(`general(stackoverflow): ${(err as Error).message}`);
    }
  }

  const normalized = dedupeResults(results).slice(0, limit);

  return {
    ok: normalized.length > 0,
    source: req.source,
    results: normalized,
    error: errors.length > 0 ? errors.join('; ') : null,
  };
}

async function searchEveUni(query: string, limit: number, timeoutMs: number): Promise<WebSearchItem[]> {
  const url = new URL('https://wiki.eveuniversity.org/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('utf8', '1');
  url.searchParams.set('srlimit', String(limit));
  url.searchParams.set('srsearch', query);

  const data = await fetchJson(url.toString(), timeoutMs) as {
    query?: { search?: Array<{ title?: string; snippet?: string }> };
  };

  const items = data?.query?.search ?? [];
  return items
    .map((item) => {
      const title = item.title ?? '';
      if (!title) return null;
      const snippet = stripHtml(item.snippet ?? '');
      const url = `https://wiki.eveuniversity.org/${encodeURIComponent(title.replace(/ /g, '_'))}`;
      return {
        title,
        url,
        snippet,
        source: 'EVE University Wiki',
      } as WebSearchItem;
    })
    .filter((item): item is WebSearchItem => !!item);
}

async function searchEsiDocs(query: string, limit: number, timeoutMs: number): Promise<WebSearchItem[]> {
  const spec = await loadEsiSpec(timeoutMs);
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: WebSearchItem[] = [];

  for (const [pathKey, ops] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(ops)) {
      if (!SUPPORTED_METHODS.has(method)) continue;
      const summary = (operation.summary ?? operation.description ?? '') as string;
      const haystack = `${pathKey} ${summary}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      results.push({
        title: `${method.toUpperCase()} ${pathKey}`,
        url: 'https://esi.evetech.net/ui/',
        snippet: summary.trim().slice(0, 300),
        source: 'ESI Swagger',
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}

async function searchWikipedia(query: string, limit: number, timeoutMs: number): Promise<WebSearchItem[]> {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('utf8', '1');
  url.searchParams.set('srlimit', String(limit));
  url.searchParams.set('srsearch', query);

  const data = await fetchJson(url.toString(), timeoutMs) as {
    query?: { search?: Array<{ title?: string; snippet?: string }> };
  };

  const items = data?.query?.search ?? [];
  return items
    .map((item) => {
      const title = item.title ?? '';
      if (!title) return null;
      const snippet = stripHtml(item.snippet ?? '');
      const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
      return {
        title,
        url,
        snippet,
        source: 'Wikipedia',
      } as WebSearchItem;
    })
    .filter((item): item is WebSearchItem => !!item);
}

async function searchStackOverflow(query: string, limit: number, timeoutMs: number): Promise<WebSearchItem[]> {
  const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('site', 'stackoverflow');
  url.searchParams.set('pagesize', String(limit));
  url.searchParams.set('q', query);

  const data = await fetchJson(url.toString(), timeoutMs) as {
    items?: Array<{ title?: string; link?: string; excerpt?: string }>;
  };
  const items = data?.items ?? [];
  return items
    .map((item) => {
      const title = item.title ?? '';
      const url = item.link ?? '';
      if (!title || !url) return null;
      const snippet = stripHtml(item.excerpt ?? '');
      return {
        title,
        url,
        snippet,
        source: 'Stack Overflow',
      } as WebSearchItem;
    })
    .filter((item): item is WebSearchItem => !!item);
}

async function searchOpenAiWeb(query: string, limit: number): Promise<WebSearchItem[]> {
  const [wikiResults, stackResults] = await Promise.all([
    searchWikipedia(query, limit, DEFAULT_TIMEOUT_MS).catch(() => []),
    searchStackOverflow(query, limit, DEFAULT_TIMEOUT_MS).catch(() => []),
  ]);
  return dedupeResults([
    ...wikiResults.map((item) => ({ ...item, source: 'OpenAI fallback / Wikipedia' })),
    ...stackResults.map((item) => ({ ...item, source: 'OpenAI fallback / Stack Overflow' })),
  ]).slice(0, limit);
}

async function loadEsiSpec(timeoutMs: number): Promise<Record<string, unknown>> {
  if (esiSpecCache && Date.now() - esiSpecCache.loadedAt < 6 * 60 * 60 * 1000) {
    return esiSpecCache.data;
  }

  const cachePath = join(process.cwd(), 'data', 'cache', 'esi-swagger.json');
  if (existsSync(cachePath)) {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    esiSpecCache = { loadedAt: Date.now(), data };
    return data;
  }

  const data = await fetchJson('https://esi.evetech.net/latest/swagger.json', timeoutMs) as Record<string, unknown>;
  try {
    const dir = dirname(cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data));
  } catch {
    // ignore cache write errors
  }
  esiSpecCache = { loadedAt: Date.now(), data };
  return data;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'eve-agent/0.1.0',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function dedupeResults(items: WebSearchItem[]): WebSearchItem[] {
  const seen = new Set<string>();
  const deduped: WebSearchItem[] = [];

  for (const item of items) {
    const key = `${item.url.trim().toLowerCase()}|${item.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}
