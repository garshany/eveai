import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: {
      apiKey: 'test', model: 'test', baseUrl: '', apiMode: 'native_responses',
      reasoningEffort: '', store: true, compactThreshold: 100000,
    },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    security: { allowWebAuth: true },
    esi: { maxPages: 5, backoffMaxSeconds: 10 },
    userProfile: { path: './data/USER.md', refreshSeconds: 300 },
    market: { defaultRegionId: 10000002, defaultRegionName: 'The Forge' },
    compact: { messageThreshold: 50, tokenRatio: 0.6, tokenBudget: 8000, keepLast: 10, maxInputChars: 20000 },
    zkill: { baseUrl: '', timeoutMs: 5000, cacheTtlSeconds: 300, maxPastSeconds: 604800, userAgent: 'test' },
  },
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  db.prepare(`
    INSERT INTO sde_regions (region_id, name, data_json)
    VALUES (?, ?, ?)
  `).run(10000002, 'The Forge', JSON.stringify({ regionID: 10000002 }));
  db.prepare(`
    INSERT INTO sde_constellations (constellation_id, name, region_id, data_json)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    20000020, 'Kimotoro', 10000002, JSON.stringify({ constellationID: 20000020, regionID: 10000002 }),
    20000021, 'Niyabainen', 10000002, JSON.stringify({ constellationID: 20000021, regionID: 10000002 }),
  );
  db.prepare(`
    INSERT INTO sde_systems (system_id, name, constellation_id, data_json)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    30000142, 'Jita', 20000020, JSON.stringify({ systemID: 30000142 }),
    30000144, 'Perimeter', 20000020, JSON.stringify({ systemID: 30000144 }),
  );
  db.prepare(`
    INSERT INTO sde_stations (station_id, name, system_id, data_json)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    60003760, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', 30000142, JSON.stringify({}),
    60014926, 'Perimeter - Trade Hub', 30000144, JSON.stringify({}),
  );
  db.prepare(`
    INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json)
    VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
  `).run(
    50013439, 30000142, 30000144, 50013440, JSON.stringify({}),
    50013440, 30000144, 30000142, 50013439, JSON.stringify({}),
  );
  db.prepare(`
    INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    'mapPlanets', '40000001', 'Jita I', JSON.stringify({ solarSystemID: 30000142, moonIDs: [1, 2] }),
    'mapPlanets', '40000002', 'Jita II', JSON.stringify({ solarSystemID: 30000142, moonIDs: [3] }),
    'mapPlanets', '40000003', 'Perimeter I', JSON.stringify({ solarSystemID: 30000144, moonIDs: [] }),
  );
});

afterEach(() => {
  db.close();
});

describe('executeUniverseObjectCount', () => {
  it('counts systems inside a region', async () => {
    const { executeUniverseObjectCount } = await import('../../src/agent/tools.js');

    expect(executeUniverseObjectCount(db as never, {
      target_kind: 'region',
      target_name: 'The Forge',
      object_kind: 'systems',
    })).toMatchObject({
      ok: true,
      target_kind: 'region',
      target_name: 'The Forge',
      object_kind: 'systems',
      count: 2,
    });
  });

  it('counts planets inside a constellation', async () => {
    const { executeUniverseObjectCount } = await import('../../src/agent/tools.js');

    expect(executeUniverseObjectCount(db as never, {
      target_kind: 'constellation',
      target_name: 'Kimotoro',
      object_kind: 'planets',
    })).toMatchObject({
      ok: true,
      target_kind: 'constellation',
      target_name: 'Kimotoro',
      object_kind: 'planets',
      count: 3,
    });
  });

  it('counts stations inside a system', async () => {
    const { executeUniverseObjectCount } = await import('../../src/agent/tools.js');

    expect(executeUniverseObjectCount(db as never, {
      target_kind: 'system',
      target_name: 'Jita',
      object_kind: 'stations',
    })).toMatchObject({
      ok: true,
      target_kind: 'system',
      target_name: 'Jita',
      object_kind: 'stations',
      count: 1,
    });
  });
});

describe('static aggregate helpers', () => {
  it('detects simple static aggregate count goals', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');

    expect(__test__.detectStaticAggregateObjectKind('Сколько систем в моем регионе?')).toBe('systems');
    expect(__test__.detectStaticAggregateObjectKind('Сколько лун и какие хабы в регионе?')).toBeNull();
    expect(__test__.isSimpleStaticAggregateCountGoal('Сколько станций в Jita?')).toBe(true);
  });

  it('formats a deterministic answer without a second model turn', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');

    expect(__test__.tryBuildDeterministicCountAnswer(
      'Сколько систем в моем регионе?',
      [{ name: 'count_universe_objects' }],
      [{
        ok: true,
        target_kind: 'region',
        target_name: 'The Forge',
        object_kind: 'systems',
        count: 2,
      }],
    )).toBe('В регионе **The Forge** — **2 системы**.');

    expect(__test__.tryBuildDeterministicCountAnswer(
      'Сколько лун в моем регионе?',
      [{ name: 'count_moons' }],
      [{
        ok: true,
        target_kind: 'region',
        target_name: 'The Forge',
        moon_count: 3,
        system_count: 2,
        planet_count: 3,
      }],
    )).toContain('В регионе **The Forge** — **3 луны**.');
  });
});
