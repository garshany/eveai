import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { getWormholeTypes, searchSystems } from '../../src/eve/eve-scout-client.js';

const SYSTEM = {
  system_id: 31000001,
  system_name: 'J100001',
  system_class: 'c1',
  region_id: 11000001,
  region_name: 'A-R00001',
  security_status: -1,
};

const WORMHOLE_TYPE = {
  identifier: 'C140',
  type_id: 30705,
  max_jump_mass: 2_000_000_000,
  max_stable_mass: 3_300_000_000,
  max_stable_time: 1440,
  mass_regeneration: 0,
  source: ['c5', 'c6'],
  target_system_class: 'ls',
  possible_static: false,
  wandering_only: true,
  comment_public: '',
  signature_level: [1],
};

describe('EVE-Scout public client contracts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('uses the documented query parameter and coarse j-space filter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([SYSTEM]), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=86400',
        Date: 'Tue, 14 Jul 2026 12:00:00 GMT',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchSystems(db, 'J100', 'j-space', 5);

    expect(result).toMatchObject({
      ok: true,
      data: [SYSTEM],
      freshness: {
        dataThrough: '2026-07-14T12:00:00.000Z',
        cacheMaxAgeSeconds: 86400,
        cacheHit: false,
      },
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('query')).toBe('J100');
    expect(url.searchParams.has('string')).toBe(false);
    expect(url.searchParams.get('space')).toBe('j-space');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('returns cache creation time as safe freshness without another request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([SYSTEM]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await searchSystems(db, 'J100', 'j-space', 5)).ok).toBe(true);
    const cached = await searchSystems(db, 'J100', 'j-space', 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached.ok).toBe(true);
    if (cached.ok) {
      expect(cached.freshness.cacheHit).toBe(true);
      expect(cached.freshness.cacheMaxAgeSeconds).toBe(86400);
      expect(cached.freshness.dataThrough).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('fails safely when systems payload fields have the wrong types', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { ...SYSTEM, system_id: 'not-an-integer' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(searchSystems(db, 'J100', 'j-space', 5)).resolves.toEqual({
      ok: false,
      error: 'EVE-Scout returned an invalid systems payload',
      status: 502,
    });
  });

  it('validates the wormhole-type payload before returning cached public data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([WORMHOLE_TYPE]), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
    })));

    const result = await getWormholeTypes(db);
    expect(result).toMatchObject({ ok: true, data: [WORMHOLE_TYPE] });
  });
});
