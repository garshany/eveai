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
});

afterEach(() => {
  db.close();
});

function seedUniverse(): void {
  db.prepare(`
    INSERT INTO sde_regions (region_id, name, data_json)
    VALUES (?, ?, ?), (?, ?, ?)
  `).run(
    10000002, 'The Forge', JSON.stringify({ regionID: 10000002 }),
    10000043, 'Domain', JSON.stringify({ regionID: 10000043 }),
  );
  db.prepare(`
    INSERT INTO sde_constellations (constellation_id, name, region_id, data_json)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    20000020, 'Kimotoro', 10000002, JSON.stringify({ constellationID: 20000020, regionID: 10000002 }),
    20000322, 'Throne Worlds', 10000043, JSON.stringify({ constellationID: 20000322, regionID: 10000043 }),
  );
  db.prepare(`
    INSERT INTO sde_systems (system_id, name, constellation_id, data_json)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    30000142, 'Jita', 20000020, JSON.stringify({ systemID: 30000142 }),
    30000144, 'Perimeter', 20000020, JSON.stringify({ systemID: 30000144 }),
    30002187, 'Amarr', 20000322, JSON.stringify({ systemID: 30002187 }),
  );
  db.prepare(`
    INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    'mapPlanets', '40000001', 'Jita I', JSON.stringify({ solarSystemID: 30000142, moonIDs: [50000001, 50000002] }),
    'mapPlanets', '40000002', 'Jita II', JSON.stringify({ solarSystemID: 30000142, moonIDs: [50000003] }),
    'mapPlanets', '40000003', 'Perimeter I', JSON.stringify({ solarSystemID: 30000144, moonIDs: [50000004] }),
    'mapPlanets', '40000004', 'Amarr I', JSON.stringify({ solarSystemID: 30002187, moonIDs: [50000005, 50000006, 50000007] }),
  );
}

describe('executeMoonCount', () => {
  it('counts moons for a single system from mapPlanets', async () => {
    seedUniverse();
    const { executeMoonCount } = await import('../../src/agent/tools.js');

    expect(executeMoonCount(db as never, {
      target_kind: 'system',
      target_name: 'jita',
    })).toEqual({
      ok: true,
      target_kind: 'system',
      target_name: 'Jita',
      system_id: 30000142,
      constellation_name: 'Kimotoro',
      region_name: 'The Forge',
      planet_count: 2,
      moon_count: 3,
    });
  });

  it('counts moons for an entire region without mixing other regions', async () => {
    seedUniverse();
    const { executeMoonCount } = await import('../../src/agent/tools.js');

    expect(executeMoonCount(db as never, {
      target_kind: 'region',
      target_name: 'The Forge',
    })).toEqual({
      ok: true,
      target_kind: 'region',
      target_name: 'The Forge',
      region_id: 10000002,
      system_count: 2,
      planet_count: 3,
      moon_count: 4,
    });
  });
});
