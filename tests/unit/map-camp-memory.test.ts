import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import type { NormalizedKillmail } from '../../src/eve-kill/types.js';

vi.mock('../../src/eve-kill/feed-poll.js', () => ({ subscribeEveKillFeed: vi.fn(() => vi.fn()) }));
vi.mock('../../src/eve-kill/client.js', () => ({ searchKillmails: vi.fn() }));

const { buildMapGraph, invalidateMapGraphCache, nearestGate } = await import('../../src/eve/map-graph.js');
const {
  getGateCampHistory,
  getRecentKills,
  recordKillmail,
  resetMapKillIndexForTests,
  sweepKillIndex,
} = await import('../../src/eve-map/kill-index.js');

const SYSTEM = 30000142;
const GATE_TO_PERIMETER = 50000001;
const GATE_TO_SOBASEKI = 50000002;
const AU_M = 149_597_870_700;
/** Среда 19:00 UTC — «будни, вечер по EVE». */
const EVENING = Date.parse('2026-07-29T19:05:00.000Z');

function seedGraph(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  db.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('1', 'now');
  db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (1, ?, ?)').run('The Forge', '{}');
  db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (1, ?, 1, ?)').run('Kimotoro', '{}');

  const system = db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
  const geometry = (x: number): string => JSON.stringify({ securityStatus: 0.9, position2D: { x, y: 0 } });
  system.run(SYSTEM, 'Jita', geometry(0));
  system.run(30000144, 'Perimeter', geometry(1));
  system.run(30000145, 'Sobaseki', geometry(2));

  const gate = db.prepare('INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, NULL, ?)');
  gate.run(GATE_TO_PERIMETER, SYSTEM, 30000144, JSON.stringify({ position: { x: 0, y: 0, z: 0 } }));
  gate.run(GATE_TO_SOBASEKI, SYSTEM, 30000145, JSON.stringify({ position: { x: AU_M, y: 0, z: 0 } }));
  gate.run(50000003, 30000144, SYSTEM, JSON.stringify({ position: { x: 0, y: 0, z: 0 } }));
  buildMapGraph(db, { force: true });
}

function killAt(
  id: number,
  x: number,
  timeMs: number,
  attacker: { characterId?: number; characterName?: string; corporationName?: string } = {},
): NormalizedKillmail {
  return {
    killmailId: id,
    killmailTime: new Date(timeMs).toISOString(),
    solarSystemId: SYSTEM,
    regionId: 1,
    totalValue: 50_000_000,
    attackerCount: 4,
    isNpc: false,
    isSolo: false,
    victim: { characterName: 'Prey', shipName: 'Badger', shipGroupName: 'hauler' },
    attackers: [{
      characterId: attacker.characterId ?? 777,
      characterName: attacker.characterName ?? 'Ganker',
      corporationName: attacker.corporationName ?? 'CODE.',
      shipName: 'Catalyst',
      finalBlow: true,
    }],
    items: [],
    siblings: [],
    position: { x, y: 0, z: 0 },
    sourceShape: 'feed',
  } as NormalizedKillmail;
}

describe('gate attribution at ingest', () => {
  let db: Database.Database;

  beforeEach(() => {
    invalidateMapGraphCache();
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    seedGraph(db);
    resetMapKillIndexForTests();
  });

  afterEach(() => {
    resetMapKillIndexForTests();
    db.close();
    invalidateMapGraphCache();
  });

  it('finds the gate a kill happened on', () => {
    expect(nearestGate(db, SYSTEM, { x: 14_581, y: 0, z: 0 })?.gateId).toBe(GATE_TO_PERIMETER);
  });

  it('returns nothing for a kill away from every gate', () => {
    expect(nearestGate(db, SYSTEM, { x: AU_M / 2, y: 0, z: 0 })).toBeNull();
  });

  it('tags an ingested kill with its gate', () => {
    const indexed = recordKillmail(db, killAt(1, 10_000, EVENING), 'feed', EVENING);
    expect(indexed?.gateId).toBe(GATE_TO_PERIMETER);
    expect(getRecentKills(db, SYSTEM)[0]!.gateId).toBe(GATE_TO_PERIMETER);
  });

  it('leaves a kill elsewhere in the system unattributed', () => {
    const indexed = recordKillmail(db, killAt(2, AU_M / 2, EVENING), 'feed', EVENING);
    expect(indexed?.gateId).toBeNull();
  });

  it('never attributes an NPC kill to a gate', () => {
    const npc = { ...killAt(3, 1_000, EVENING), isNpc: true };
    expect(recordKillmail(db, npc, 'feed', EVENING)?.gateId).toBeNull();
  });
});

describe('camp memory', () => {
  let db: Database.Database;

  beforeEach(() => {
    invalidateMapGraphCache();
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    seedGraph(db);
    resetMapKillIndexForTests();
  });

  afterEach(() => {
    resetMapKillIndexForTests();
    db.close();
    invalidateMapGraphCache();
  });

  it('accumulates kills per gate per hour of the week', () => {
    recordKillmail(db, killAt(10, 1_000, EVENING), 'feed', EVENING);
    recordKillmail(db, killAt(11, 5_000, EVENING + 60_000), 'feed', EVENING);
    // Через неделю в тот же час — та же ячейка «будни 19:00».
    recordKillmail(db, killAt(12, 2_000, EVENING + 7 * 24 * 3_600_000), 'feed', EVENING);

    const history = getGateCampHistory(db, SYSTEM);
    expect(history).toHaveLength(1);
    expect(history[0]!.gateId).toBe(GATE_TO_PERIMETER);
    expect(history[0]!.totalKills).toBe(3);
    expect(history[0]!.peakHours[0]).toEqual({ hourOfWeek: 3 * 24 + 19, kills: 3 });
    expect(history[0]!.destinationSystemId).toBe(30000144);
  });

  it('names who keeps making the kills', () => {
    recordKillmail(db, killAt(20, 1_000, EVENING, { characterId: 1, characterName: 'Alpha', corporationName: 'CODE.' }), 'feed', EVENING);
    recordKillmail(db, killAt(21, 1_000, EVENING, { characterId: 1, characterName: 'Alpha', corporationName: 'CODE.' }), 'feed', EVENING);
    recordKillmail(db, killAt(22, 1_000, EVENING, { characterId: 2, characterName: 'Beta' }), 'feed', EVENING);

    const regulars = getGateCampHistory(db, SYSTEM)[0]!.campers;
    expect(regulars[0]).toMatchObject({ characterId: 1, name: 'Alpha', corporation: 'CODE.', kills: 2 });
    expect(regulars.find((camper) => camper.characterId === 2)?.kills).toBe(1);
  });

  it('keeps gates apart', () => {
    recordKillmail(db, killAt(30, 1_000, EVENING), 'feed', EVENING);
    recordKillmail(db, killAt(31, AU_M + 1_000, EVENING), 'feed', EVENING);

    const history = getGateCampHistory(db, SYSTEM);
    expect(history.map((gate) => gate.gateId).sort()).toEqual([GATE_TO_PERIMETER, GATE_TO_SOBASEKI]);
  });

  it('is empty for a system that has seen nothing', () => {
    expect(getGateCampHistory(db, 30000145)).toEqual([]);
  });

  it('keeps gate kills past the short rolling retention', () => {
    const old = EVENING - 10 * 3_600_000;
    recordKillmail(db, killAt(40, 1_000, old), 'feed', old);
    recordKillmail(db, killAt(41, AU_M / 2, old), 'feed', old);

    sweepKillIndex(db, EVENING);

    const rows = db.prepare('SELECT killmail_id, gate_id FROM map_kill_events').all() as Array<{
      killmail_id: number; gate_id: number | null;
    }>;
    // Кил не на гейте вымело по трёхчасовому окну; гейт-кил — доказательство
    // кемпа и живёт неделями.
    expect(rows).toEqual([{ killmail_id: 40, gate_id: GATE_TO_PERIMETER }]);
  });

  it('sweeps gate kills once they pass their own long retention', () => {
    const ancient = EVENING - 400 * 24 * 3_600_000;
    recordKillmail(db, killAt(50, 1_000, ancient), 'feed', ancient);
    sweepKillIndex(db, EVENING);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM map_kill_events').get() as { n: number };
    expect(rows.n).toBe(0);
    // Сырьё ушло, память о кемпе осталась.
    expect(getGateCampHistory(db, SYSTEM)[0]!.totalKills).toBe(1);
  });
});
