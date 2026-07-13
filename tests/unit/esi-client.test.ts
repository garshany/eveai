import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback',
      requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/',
      specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json',
      compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/2.1 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5,
      backoffMaxSeconds: 1,
      requestTimeoutMs: 5000,
      retryMaxAttempts: 3,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, handoffTtlSeconds: 300 },
  },
}));

import { callEsiOperation, pruneExpiredEsiCache } from '../../src/eve/esi-client.js';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  db.close();
});

describe('esi client', () => {
  it('revalidates cached GET responses with If-None-Match and accepts 304', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ players: 123 }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ETag: '"etag-1"',
          Expires: new Date(Date.now() + 60_000).toUTCString(),
        },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: {
          ETag: '"etag-1"',
          Expires: new Date(Date.now() + 120_000).toUTCString(),
        },
      }));

    const first = await callEsiOperation<{ players: number }>(db, 'get_status', {}, { userId: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Expected initial ESI call to succeed');
    expect(first.cached).toBe(false);
    expect(first.data.players).toBe(123);

    db.prepare("UPDATE esi_cache SET expires_at = datetime('now', '-1 second')").run();

    const second = await callEsiOperation<{ players: number }>(db, 'get_status', {}, { userId: 0 });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Expected cached ESI call to succeed');
    expect(second.cached).toBe(true);
    expect(second.data.players).toBe(123);

    const secondCallHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers as HeadersInit);
    expect(secondCallHeaders.get('If-None-Match')).toBe('"etag-1"');
  });

  it('returns the cached body on a 304 that omits an Expires header', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ players: 456 }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ETag: '"etag-2"',
          Expires: new Date(Date.now() + 60_000).toUTCString(),
        },
      }))
      // 304 with NO Expires header — must still return the cached body, not 502.
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: { ETag: '"etag-2"' },
      }));

    const first = await callEsiOperation<{ players: number }>(db, 'get_status', {}, { userId: 0 });
    expect(first.ok).toBe(true);

    db.prepare("UPDATE esi_cache SET expires_at = datetime('now', '-1 second')").run();

    const second = await callEsiOperation<{ players: number }>(db, 'get_status', {}, { userId: 0 });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Expected 304-without-Expires to serve the cached body');
    expect(second.status).toBe(200);
    expect(second.cached).toBe(true);
    expect(second.data.players).toBe(456);
  });

  it('retries 429 responses and respects Retry-After', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'slow down' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '1',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ players: 321 }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Expires: new Date(Date.now() + 60_000).toUTCString(),
        },
      }));

    const resultPromise = callEsiOperation<{ players: number }>(db, 'get_status', {}, { userId: 0 });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected retried ESI call to succeed');
    expect(result.data.players).toBe(321);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails instead of silently truncating X-Pages responses above ESI_MAX_PAGES', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ order_id: 1 }]), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Pages': '7',
        Expires: new Date(Date.now() + 60_000).toUTCString(),
      },
    }));

    const result = await callEsiOperation(db, 'get_markets_region_id_orders', {
      region_id: 10000002,
      order_type: 'all',
      fields: null,
    }, { userId: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected paginated ESI call to fail');
    expect(result.status).toBe(422);
    expect(result.error).toContain('ESI_MAX_PAGES');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts X-Pages collections when pages have different ETags but the same Last-Modified snapshot', async () => {
    const expires = new Date(Date.now() + 60_000).toUTCString();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([{ order_id: 1 }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Pages': '2',
          ETag: '"page-1"',
          'Last-Modified': 'Wed, 25 Mar 2026 00:00:00 GMT',
          Expires: expires,
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ order_id: 2 }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Pages': '2',
          ETag: '"page-2"',
          'Last-Modified': 'Wed, 25 Mar 2026 00:00:00 GMT',
          Expires: expires,
        },
      }));

    const result = await callEsiOperation<Array<{ order_id: number }>>(db, 'get_markets_region_id_orders', {
      region_id: 10000002,
      order_type: 'all',
      fields: null,
    }, { userId: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected paginated ESI call to succeed');
    expect(result.data).toEqual([{ order_id: 1 }, { order_id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the paginated Last-Modified snapshot changes mid-collection', async () => {
    const expires = new Date(Date.now() + 60_000).toUTCString();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([{ order_id: 1 }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Pages': '2',
          ETag: '"page-1"',
          'Last-Modified': 'Wed, 25 Mar 2026 00:00:00 GMT',
          Expires: expires,
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ order_id: 2 }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Pages': '2',
          ETag: '"page-2"',
          'Last-Modified': 'Wed, 25 Mar 2026 00:01:00 GMT',
          Expires: expires,
        },
      }));

    const result = await callEsiOperation(db, 'get_markets_region_id_orders', {
      region_id: 10000002,
      order_type: 'all',
      fields: null,
    }, { userId: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected paginated ESI call to fail on snapshot drift');
    expect(result.status).toBe(409);
    expect(result.error).toContain('changed during collection');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pruneExpiredEsiCache deletes rows past the grace window and keeps fresh ones', () => {
    db.prepare("INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at) VALUES ('fresh', '{}', datetime('now','+1 hour'), datetime('now'))").run();
    db.prepare("INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at) VALUES ('recent', '{}', datetime('now','-1 hour'), datetime('now'))").run();
    db.prepare("INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at) VALUES ('stale', '{}', datetime('now','-2 days'), datetime('now'))").run();

    const removed = pruneExpiredEsiCache(db);

    expect(removed).toBe(1);
    const keys = (db.prepare('SELECT cache_key FROM esi_cache ORDER BY cache_key').all() as Array<{ cache_key: string }>)
      .map((r) => r.cache_key);
    expect(keys).toEqual(['fresh', 'recent']);
  });
});
