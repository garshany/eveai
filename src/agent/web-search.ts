import { config } from '../config.js';

const WEB_SEARCH_TIMEOUT_MS = 8000;
const MAX_WEB_SEARCHES_PER_TURN = 2;

export type WebSearchState = {
  normalizedQueries: string[];
  eveKillCallCount: number;
  eveKillAnalyticsCallCount: number;
};

export function createWebSearchState(): WebSearchState {
  return { normalizedQueries: [], eveKillCallCount: 0, eveKillAnalyticsCallCount: 0 };
}

export function registerWebSearch(
  state: WebSearchState,
  query: string,
): { allowed: boolean; reason: string | null } {
  const normalized = normalizeWebSearchQuery(query);
  const prior = state.normalizedQueries;

  if (prior.includes(normalized)) {
    return {
      allowed: false,
      reason: 'Повторный web_search с тем же запросом запрещён. Используй уже найденные источники и сформируй ответ.',
    };
  }

  const hasSimilarPrior = prior.some((entry) => areSimilarWebSearchQueries(entry, normalized));
  if (prior.length >= MAX_WEB_SEARCHES_PER_TURN || (prior.length >= 2 && hasSimilarPrior)) {
    return {
      allowed: false,
      reason: 'Достигнут лимит web_search на один ответ. После 1-2 поисков нужно ответить по найденным данным или явно указать, чего не хватило.',
    };
  }

  state.normalizedQueries.push(normalized);
  return { allowed: true, reason: null };
}

export function normalizeWebSearchQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/site:[^\s]+/g, ' ')
    .replace(/["'`()[\],.:;!?/+_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function areSimilarWebSearchQueries(left: string, right: string): boolean {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return left === right;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const similarity = overlap / Math.min(leftTokens.size, rightTokens.size);
  return similarity >= 0.6;
}

export async function executeWebSearch(query: string): Promise<{ ok: boolean; results: Array<{ title: string; url: string; snippet: string; source: string }>; error: string | null }> {
  if (!query.trim()) return { ok: false, results: [], error: 'Empty query' };

  const results: Array<{ title: string; url: string; snippet: string; source: string }> = [];
  const errors: string[] = [];

  const tavilyKey = config.tavily?.apiKey;
  const searches = [
    ...(tavilyKey ? [fetchTavily(query, tavilyKey)] : []),
    fetchEveUni(query),
  ];

  const settled = await Promise.allSettled(searches);
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value);
    else errors.push(String(s.reason));
  }

  // Dedupe by URL
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    const key = r.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);

  return { ok: deduped.length > 0, results: deduped, error: errors.length > 0 ? errors.join('; ') : null };
}

async function fetchTavily(query: string, apiKey: string): Promise<Array<{ title: string; url: string; snippet: string; source: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        topic: 'general',
        search_depth: 'basic',
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data?.results ?? [])
      .filter((r) => r.title && r.url)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        snippet: (r.content ?? '').slice(0, 300),
        source: 'Tavily',
      }));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEveUni(query: string): Promise<Array<{ title: string; url: string; snippet: string; source: string }>> {
  const url = new URL('https://wiki.eveuniversity.org/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('utf8', '1');
  url.searchParams.set('srlimit', '5');
  url.searchParams.set('srsearch', query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal, headers: { 'User-Agent': 'EVEAI/3.0 (+https://github.com/example/eveai; contact=operator@example.com)' } });
    if (!res.ok) return [];
    const data = await res.json() as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
    return (data?.query?.search ?? [])
      .filter((i) => i.title)
      .map((i) => ({
        title: i.title!,
        url: `https://wiki.eveuniversity.org/${encodeURIComponent(i.title!.replace(/ /g, '_'))}`,
        snippet: (i.snippet ?? '').replace(/<[^>]*>/g, '').slice(0, 300),
        source: 'EVE University Wiki',
      }));
  } finally {
    clearTimeout(timer);
  }
}
