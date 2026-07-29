import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/eve-kill/feed-poll.js', () => ({ subscribeEveKillFeed: vi.fn(() => vi.fn()) }));
vi.mock('../../src/eve-kill/client.js', () => ({ searchKillmails: vi.fn() }));
const signaturesMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/eve/eve-scout-client.js', () => ({ getSignatures: signaturesMock }));

const { buildMapGraph, invalidateMapGraphCache } = await import('../../src/eve/map-graph.js');
const { getUniverseActivity, getUniverseStatic, getUniverseWormholes, resetUniverseCachesForTests } =
  await import('../../src/eve-map/universe.js');

const NOW = Date.parse('2026-07-29T19:00:00.000Z');

function seed(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  db.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('3389399', 'now');
  db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (10000002, ?, ?)').run('The Forge', '{}');
  db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (1, ?, 10000002, ?)')
    .run('Kimotoro', '{}');

  const system = db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
  system.run(30000142, 'Jita', JSON.stringify({ securityStatus: 0.946, position2D: { x: 10, y: -4 } }));
  system.run(30000144, 'Perimeter', JSON.stringify({ securityStatus: 0.953, position2D: { x: 12, y: -4 } }));
  system.run(30002813, 'Rancer', JSON.stringify({ securityStatus: 0.4, position2D: { x: -30, y: 8 } }));

  const gate = db.prepare('INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, NULL, ?)');
  gate.run(1, 30000142, 30000144, '{}');
  gate.run(2, 30000144, 30000142, '{}');
  buildMapGraph(db, { force: true });
}

function insertKill(
  db: Database.Database,
  options: { id: number; systemId: number; ageMinutes: number; npc?: boolean; gateId?: number | null; value?: number },
): void {
  db.prepare(`
    INSERT INTO map_kill_events (
      killmail_id, system_id, region_id, killmail_time, killmail_time_ms, received_at_ms,
      total_value, attacker_count, is_npc, is_solo, gate_id
    ) VALUES (?, ?, 10000002, NULL, ?, ?, ?, 3, ?, 0, ?)
  `).run(
    options.id,
    options.systemId,
    NOW - options.ageMinutes * 60_000,
    NOW,
    options.value ?? 1_000_000,
    options.npc ? 1 : 0,
    options.gateId ?? null,
  );
}

describe('whole-cluster map', () => {
  let db: Database.Database;

  beforeEach(() => {
    invalidateMapGraphCache();
    resetUniverseCachesForTests();
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    seed(db);
  });

  afterEach(() => {
    resetUniverseCachesForTests();
    invalidateMapGraphCache();
    db.close();
  });

  it('serves every system as parallel arrays, not repeated objects', () => {
    const universe = getUniverseStatic(db)!;
    expect(universe.count).toBe(3);
    expect(universe.systemIds).toHaveLength(3);
    expect(universe.names).toHaveLength(3);
    expect(universe.security).toHaveLength(3);
    expect(universe.x).toHaveLength(3);
    expect(universe.regionNames[10000002]).toBe('The Forge');
  });

  it('rounds security the way the client shows it', () => {
    const universe = getUniverseStatic(db)!;
    const jita = universe.systemIds.indexOf(30000142);
    expect(universe.security[jita]).toBe(0.95);
  });

  it('sends each gate link once, not twice', () => {
    const universe = getUniverseStatic(db)!;
    // map_edges keeps both directions so BFS stays one query; the wire payload
    // must not pay for that twice.
    expect(universe.edges).toEqual([30000142, 30000144]);
  });

  it('reports bounds so the client can fit the view without scanning', () => {
    const universe = getUniverseStatic(db)!;
    expect(universe.bounds).toEqual({ minX: -30, maxX: 12, minY: -4, maxY: 8 });
  });

  it('caches static geometry across calls', () => {
    expect(getUniverseStatic(db)).toBe(getUniverseStatic(db));
  });

  it('reports only systems with activity', () => {
    insertKill(db, { id: 1, systemId: 30000142, ageMinutes: 10 });
    const activity = getUniverseActivity(db, NOW);
    expect(activity.systemIds).toEqual([30000142]);
    expect(activity.totals.activeSystems).toBe(1);
  });

  it('never colours a ratting system as hostile', () => {
    insertKill(db, { id: 2, systemId: 30002813, ageMinutes: 5, npc: true });
    const activity = getUniverseActivity(db, NOW);
    const index = activity.systemIds.indexOf(30002813);
    // NPC-килы видно, но опасности для проходящего они не значат.
    expect(activity.npcKills1h[index]).toBe(1);
    expect(activity.kills1h[index]).toBe(0);
    expect(activity.bands[index]).toBe('calm');
  });

  it('weighs a gate camp above scattered volume', () => {
    insertKill(db, { id: 10, systemId: 30000142, ageMinutes: 5, gateId: 50000001 });
    insertKill(db, { id: 11, systemId: 30000142, ageMinutes: 6, gateId: 50000001 });
    for (let index = 0; index < 4; index += 1) {
      insertKill(db, { id: 20 + index, systemId: 30000144, ageMinutes: 5 });
    }

    const activity = getUniverseActivity(db, NOW);
    const camped = activity.bands[activity.systemIds.indexOf(30000142)]!;
    const busy = activity.bands[activity.systemIds.indexOf(30000144)]!;
    const rank = ['calm', 'watch', 'elevated', 'hostile', 'lethal'];
    // Два трупа на одном гейте важнее для проходящего, чем вдвое больше килов,
    // размазанных по системе.
    expect(rank.indexOf(camped)).toBeGreaterThanOrEqual(rank.indexOf(busy));
    expect(activity.totals.campedSystems).toBe(1);
  });

  it('drops activity that fell out of the window', () => {
    insertKill(db, { id: 30, systemId: 30000142, ageMinutes: 90 });
    expect(getUniverseActivity(db, NOW).systemIds).toEqual([]);
  });

  it('shares one rollup between viewers instead of recomputing per tab', () => {
    insertKill(db, { id: 40, systemId: 30000142, ageMinutes: 5 });
    const first = getUniverseActivity(db, NOW);
    insertKill(db, { id: 41, systemId: 30000144, ageMinutes: 5 });
    // Внутри TTL второй зритель получает тот же объект — расчёт один на всех.
    expect(getUniverseActivity(db, NOW + 1000)).toBe(first);
  });

  it('refuses to present stale traffic as current', () => {
    db.prepare(`
      INSERT INTO map_system_hourly (system_id, hour_start_ms, ship_jumps, ship_kills, npc_kills, pod_kills)
      VALUES (?, ?, 900, 0, 0, 0)
    `).run(30000142, NOW - 30 * 3_600_000);
    expect(getUniverseActivity(db, NOW).baselineJumps).toEqual({});
  });

  it('carries fresh traffic through', () => {
    db.prepare(`
      INSERT INTO map_system_hourly (system_id, hour_start_ms, ship_jumps, ship_kills, npc_kills, pod_kills)
      VALUES (?, ?, 2761, 42, 131, 0)
    `).run(30000142, NOW - 3_600_000);
    expect(getUniverseActivity(db, NOW).baselineJumps[30000142]).toBe(2761);
  });
});

/**
 * EVE-Scout уже был подключён, но выходы отбрасывались фильтром пузыря — на
 * общей карте, где их и надо искать, не было ни одного.
 */
describe('EVE-Scout exits for the whole cluster', () => {
  let db: Database.Database;

  function signature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'sig-1',
      out_system_id: 30000142,
      in_system_id: 30002813,
      in_system_name: 'Rancer',
      wh_type: 'K162',
      max_ship_size: 'large',
      remaining_hours: 12,
      expires_at: new Date(NOW + 12 * 3_600_000).toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    resetUniverseCachesForTests();
    invalidateMapGraphCache();
    signaturesMock.mockReset();
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    seed(db);
  });

  afterEach(() => {
    db.close();
    resetUniverseCachesForTests();
    invalidateMapGraphCache();
  });

  it('keeps exits the bubble builder would have thrown away', async () => {
    signaturesMock.mockResolvedValue({ ok: true, data: [signature()] });
    const payload = await getUniverseWormholes(db, NOW);
    expect(payload.error).toBeNull();
    expect(payload.links).toHaveLength(1);
    expect(payload.links[0]).toMatchObject({ fromSystemId: 30000142, toSystemId: 30002813 });
  });

  it('drops a hole that has already collapsed', async () => {
    signaturesMock.mockResolvedValue({
      ok: true,
      data: [signature({ expires_at: new Date(NOW - 60_000).toISOString() })],
    });
    expect((await getUniverseWormholes(db, NOW)).links).toEqual([]);
  });

  it('drops a link with an end this map cannot place', async () => {
    // Иначе линия уедет в начало координат — прямая в никуда.
    signaturesMock.mockResolvedValue({ ok: true, data: [signature({ in_system_id: 31000005 })] });
    expect((await getUniverseWormholes(db, NOW)).links).toEqual([]);
  });

  it('drops a signature that is not a wormhole', async () => {
    signaturesMock.mockResolvedValue({ ok: true, data: [signature({ signature_type: 'combat' })] });
    expect((await getUniverseWormholes(db, NOW)).links).toEqual([]);
  });

  it('reports an EVE-Scout outage instead of pretending there are no holes', async () => {
    signaturesMock.mockResolvedValue({ ok: false, error: 'upstream timeout' });
    const payload = await getUniverseWormholes(db, NOW);
    expect(payload.links).toEqual([]);
    expect(payload.error).toBe('upstream timeout');
  });

  it('asks EVE-Scout once for every viewer, not once per viewer', async () => {
    signaturesMock.mockResolvedValue({ ok: true, data: [signature()] });
    await getUniverseWormholes(db, NOW);
    await getUniverseWormholes(db, NOW + 1_000);
    expect(signaturesMock).toHaveBeenCalledTimes(1);
  });
});
