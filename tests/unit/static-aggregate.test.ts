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
    compact: { maxInputChars: 20000 },
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
    'mapPlanets', '40000001', 'Jita I', JSON.stringify({ solarSystemID: 30000142, moonIDs: [1, 2], asteroidBeltIDs: [10] }),
    'mapPlanets', '40000002', 'Jita II', JSON.stringify({ solarSystemID: 30000142, moonIDs: [3], asteroidBeltIDs: [11, 12] }),
    'mapPlanets', '40000003', 'Perimeter I', JSON.stringify({ solarSystemID: 30000144, moonIDs: [], asteroidBeltIDs: [] }),
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

  it('counts asteroid belts inside a system', async () => {
    const { executeUniverseObjectCount } = await import('../../src/agent/tools.js');

    expect(executeUniverseObjectCount(db as never, {
      target_kind: 'system',
      target_name: 'Jita',
      object_kind: 'asteroid_belts',
    })).toMatchObject({
      ok: true,
      target_kind: 'system',
      target_name: 'Jita',
      object_kind: 'asteroid_belts',
      count: 3,
    });
  });
});

describe('static aggregate helpers', () => {
  it('derives live-context needs only for current-state questions', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');

    expect(__test__.deriveLiveContextNeeds('Сколько систем в регионе The Forge?')).toEqual({
      location: false,
      ship: false,
    });
    expect(__test__.deriveLiveContextNeeds('Сколько систем в моем регионе?')).toEqual({
      location: true,
      ship: false,
    });
    expect(__test__.deriveLiveContextNeeds('How many moons here?')).toEqual({
      location: true,
      ship: false,
    });
    expect(__test__.deriveLiveContextNeeds('На чем я сейчас летаю?')).toEqual({
      location: true,
      ship: true,
    });
  });

  it('detects simple static aggregate count goals', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');

    expect(__test__.detectStaticAggregateObjectKind('Сколько систем в моем регионе?')).toBe('systems');
    expect(__test__.detectStaticAggregateObjectKind('Сколько астероидных поясов в Jita?')).toBe('asteroid_belts');
    expect(__test__.detectStaticAggregateObjectKind('Количество систем в The Forge')).toBe('systems');
    expect(__test__.detectStaticAggregateObjectKind('Сколько лун и какие хабы в регионе?')).toBeNull();
    expect(__test__.isSimpleStaticAggregateCountGoal('Сколько станций в Jita?')).toBe(true);
  });

  it('parses current-location and explicit static aggregate intents', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');

    expect(__test__.parseStaticAggregateIntent(db as never, 'Сколько систем в моем регионе?', {
      systemName: 'Jita',
      security: 0.9,
      constellationName: 'Kimotoro',
      regionName: 'The Forge',
    })).toEqual({
      objectKind: 'systems',
      targetKind: 'region',
      targetName: 'The Forge',
    });

    expect(__test__.parseStaticAggregateIntent(db as never, 'Сколько станций в системе Jita?', null)).toEqual({
      objectKind: 'stations',
      targetKind: 'system',
      targetName: 'Jita',
    });

    expect(__test__.parseStaticAggregateIntent(db as never, 'Сколько систем в The Forge?', null)).toEqual({
      objectKind: 'systems',
      targetKind: 'region',
      targetName: 'The Forge',
    });

    expect(__test__.parseStaticAggregateIntent(db as never, 'How many systems are in The Forge?', null)).toEqual({
      objectKind: 'systems',
      targetKind: 'region',
      targetName: 'The Forge',
    });

    expect(__test__.parseStaticAggregateIntent(db as never, 'Сколько лун в моем созвездии?', {
      systemName: 'Jita',
      security: 0.9,
      constellationName: 'Kimotoro',
      regionName: 'The Forge',
    })).toEqual({
      objectKind: 'moons',
      targetKind: 'constellation',
      targetName: 'Kimotoro',
    });
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
      [{ name: 'count_universe_objects' }],
      [{
        ok: true,
        target_kind: 'region',
        target_name: 'The Forge',
        object_kind: 'moons',
        count: 3,
        system_count: 2,
        planet_count: 3,
      }],
    )).toContain('В регионе **The Forge** — **3 луны**.');

    expect(__test__.tryBuildDeterministicCountAnswer(
      'Сколько астероидных поясов в Jita?',
      [{ name: 'count_universe_objects' }],
      [{
        ok: true,
        target_kind: 'system',
        target_name: 'Jita',
        object_kind: 'asteroid_belts',
        count: 3,
      }],
    )).toBe('В системе **Jita** — **3 астероидных пояса**.');
  });

  it('can answer a current-region aggregate question before entering the model loop', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(1);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 1);

    const answer = __test__.tryHandleStaticAggregateFastPath(
      db as never,
      't1',
      'Сколько систем в моем регионе?',
      {
        systemName: 'Jita',
        security: 0.9,
        constellationName: 'Kimotoro',
        regionName: 'The Forge',
      },
    );

    expect(answer).toBe('В регионе **The Forge** — **2 системы**.');
    const stored = db.prepare("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY id ASC").all('t1') as Array<{ role: string; content: string }>;
    expect(stored.at(-1)).toEqual({ role: 'assistant', content: 'В регионе **The Forge** — **2 системы**.' });
  });

  it('can answer a bare-name aggregate question before entering the model loop', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(2);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t2', 2);

    const answer = __test__.tryHandleStaticAggregateFastPath(
      db as never,
      't2',
      'Сколько станций в Jita?',
      null,
    );

    expect(answer).toBe('В системе **Jita** — **1 станция**.');
    const stored = db.prepare("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY id ASC").all('t2') as Array<{ role: string; content: string }>;
    expect(stored.at(-1)).toEqual({ role: 'assistant', content: 'В системе **Jita** — **1 станция**.' });
  });

  it('can answer a current-constellation moon question before entering the model loop', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(3);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t3', 3);

    const answer = __test__.tryHandleStaticAggregateFastPath(
      db as never,
      't3',
      'Сколько лун в моем созвездии?',
      {
        systemName: 'Jita',
        security: 0.9,
        constellationName: 'Kimotoro',
        regionName: 'The Forge',
      },
    );

    expect(answer).toContain('В созвездии **Kimotoro** — **3 луны**.');
    expect(answer).toContain('планет: **3**');
    const stored = db.prepare("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY id ASC").all('t3') as Array<{ role: string; content: string }>;
    expect(stored.at(-1)?.content).toContain('В созвездии **Kimotoro** — **3 луны**.');
  });
});
