import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 0 },
    openai: { apiKey: 'test', model: 'gpt-5.4', baseUrl: '', apiMode: 'native_responses', reasoningEffort: 'medium' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/callback' },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/',
      specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json',
      compatibilityDate: '2026-03-15',
      maxPages: 5,
      backoffMaxSeconds: 10,
    },
    server: { port: 3000, host: '0.0.0.0' },
    security: { allowWebAuth: true },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER.md', refreshSeconds: 300 },
    webSearch: { timeoutMs: 3000, maxResults: 5 },
    compact: { messageThreshold: 50, tokenRatio: 0.6, tokenBudget: 8000, keepLast: 10, maxInputChars: 20000 },
  },
}));

import { webSearch } from '../../src/agent/web-search.js';

describe('webSearch', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes OpenAI web search in source=all and respects global limit', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('wiki.eveuniversity.org')) {
        return jsonResponse({
          query: {
            search: [
              { title: 'PLEX', snippet: 'EVE Uni article' },
            ],
          },
        });
      }
      if (url.includes('stackoverflow')) {
        return jsonResponse({
          items: [
            { title: 'PLEX question', link: 'https://stackoverflow.com/q/1', excerpt: 'Same result' },
          ],
        });
      }
      if (url.includes('wikipedia.org')) {
        return jsonResponse({
          query: {
            search: [
              { title: 'PLEX', snippet: 'Wikipedia article' },
            ],
          },
        });
      }
      if (url.includes('swagger.json')) {
        return jsonResponse({ paths: {} });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await webSearch({ query: 'PLEX', source: 'all', limit: 2 });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.some((item) => item.url.includes('wikipedia.org'))).toBe(true);
  });

  it('returns fallback results for source=openai without OpenAI SDK transport', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('wikipedia.org')) {
        return jsonResponse({
          query: {
            search: [
              { title: 'Responses API', snippet: 'Wikipedia fallback' },
            ],
          },
        });
      }
      if (url.includes('stackoverflow')) {
        return jsonResponse({
          items: [
            { title: 'Responses API', link: 'https://stackoverflow.com/q/42', excerpt: 'SO fallback' },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await webSearch({ query: 'Responses API', source: 'openai', limit: 3 });

    expect(result.ok).toBe(true);
    expect(result.results.some((item) => item.url.includes('wikipedia.org') || item.url.includes('stackoverflow.com'))).toBe(true);
  });
});

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as Response;
}
