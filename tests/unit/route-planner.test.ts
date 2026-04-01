import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const callEsiOperationMock = vi.fn();
const getLinkedCharacterMock = vi.fn();
const getKilllistMock = vi.fn();

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

vi.mock('../../src/eve/sso.js', () => ({
  getLinkedCharacter: getLinkedCharacterMock,
}));

vi.mock('../../src/eve-kill/client.js', () => ({
  getKilllist: getKilllistMock,
}));

let db: Database.Database;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  seedRouteData(db);

  getLinkedCharacterMock.mockReturnValue({ characterId: 2116626188 });

  // Default: getKilllist returns kills per system.
  // It's called once per system in the route. Return kill only for Midpoint (30002660).
  getKilllistMock.mockImplementation(async (_db: unknown, params: Record<string, unknown>) => {
    if (params.system_id === 30002660) {
      return {
        ok: true,
        data: [{
          killmail_id: 134200001,
          killmail_time: '2026-03-22T10:15:00Z',
          solar_system_id: 30002660,
          solar_system_name: 'Midpoint',
          solar_system_security: 0.5,
          total_value: 42000000,
          is_npc: false,
          is_solo: false,
          attacker_count: 1,
          ship_name: 'Victim Ship',
          victim_character_name: 'Victim One',
          victim_corporation_name: 'Victim Corp',
          final_blow_character_name: 'Attacker One',
          final_blow_corporation_name: 'Attacker Corp',
        }],
      };
    }
    return { ok: true, data: [] };
  });

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string, args: unknown) => {
    if (operation === 'get_route_origin_destination') {
      const flag = String((args as Record<string, unknown>).flag);
      if (flag === 'secure') {
        return { ok: true, status: 200, cached: false, headers: {}, data: [30002659, 30002660, 30000142] };
      }
      if (flag === 'shortest') {
        return { ok: true, status: 200, cached: false, headers: {}, data: [30002659, 30000142] };
      }
      return { ok: true, status: 200, cached: false, headers: {}, data: [30002659, 30002661, 30000142] };
    }

    if (operation === 'post_ui_autopilot_waypoint') {
      return { ok: true, status: 204, cached: false, headers: {}, data: null };
    }

    return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
  });
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  db.close();
});

describe('route planner', () => {
  it('reads securityStatus from SDE when building route data', async () => {
    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: false,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.origin?.name).toBe('Dodixie');
    expect(result.origin?.sec).toBe(0.9);
    expect(result.destination?.name).toBe('Jita');
    expect(result.destination?.sec).toBe(0.9);
    expect(result.routes).toHaveLength(3);
    expect(result.routes[0].systems).toEqual(['Dodixie', 'Midpoint', 'Jita']);
    expect(result.routes[0].min_sec).toBe(0.5);
    expect(result.routes[0].safe_count).toBe(2);
    expect(result.routes[0].danger_systems).toHaveLength(1);
    expect(result.formatted_summary).toContain('<b>Dodixie → Jita</b>');
    expect(result.formatted_summary).toContain('нет');
    expect(result.formatted_summary).toContain('прыжков');
    expect(result.formatted_summary).toContain('secure');
  });

  it('returns a human-readable route summary with danger details and autopilot flag', async () => {
    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.autopilot_set).toBe(true);
    expect(result.autopilot_mode).toBe('exact_route');
    expect(result.formatted_summary).toContain('<b>Dodixie → Jita</b>');
    expect(result.formatted_summary).toContain('выставлен');
    expect(result.formatted_summary).toContain('Dodixie');
    expect(result.formatted_summary).toContain('Jita');
    expect(result.formatted_summary).toContain('<b>Опасные системы</b>');
    expect(result.formatted_summary).toContain('<b>Midpoint</b>');
    expect(result.formatted_summary).toContain('Victim One');
    expect(result.formatted_summary).toContain('kill</a>');
    expect(result.formatted_summary).not.toContain('{"');
    expect(callEsiOperationMock).toHaveBeenCalledWith(
      db,
      'post_ui_autopilot_waypoint',
      {
        destination_id: 30002660,
        clear_other_waypoints: true,
        add_to_beginning: false,
      },
      { userId: 1, chatId: 1 },
    );
  });

  it('keeps preferred-route risk metrics separate from merged danger coverage and shows route association', async () => {
    // Kills in multiple systems: Dodixie, Midpoint, Scout Gate
    const mkKill = (id: number, sysId: number, sysName: string) => ({
      killmail_id: id,
      killmail_time: '2026-03-22T10:15:00Z',
      solar_system_id: sysId,
      solar_system_name: sysName,
      total_value: 42000000,
      is_npc: false,
      attacker_count: 1,
      ship_name: 'Victim Ship',
      victim_character_name: 'Victim One',
      final_blow_character_name: 'Attacker One',
    });
    getKilllistMock.mockImplementation(async (_db: unknown, params: Record<string, unknown>) => {
      const sysId = params.system_id as number;
      if (sysId === 30002659) return { ok: true, data: [mkKill(134200010, 30002659, 'Dodixie')] };
      if (sysId === 30002660) return { ok: true, data: [mkKill(134200011, 30002660, 'Midpoint')] };
      if (sysId === 30002661) return { ok: true, data: [mkKill(134200012, 30002661, 'Scout Gate')] };
      return { ok: true, data: [] };
    });

    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: false,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.formatted_summary).toContain('киллов/ч: 2');
    expect(result.formatted_summary).toContain('<b>Dodixie</b>');
    expect(result.formatted_summary).toContain('42M ISK');
    expect(result.formatted_summary).toContain('<b>Scout Gate</b>');
    expect(result.formatted_summary).toContain('[insecure]');
  });
});

function seedRouteData(db: Database.Database): void {
  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
    10000002,
    'The Forge',
    JSON.stringify({ region_id: 10000002, name: 'The Forge' }),
  );
  db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
    20000389,
    'Kimotoro',
    10000002,
    JSON.stringify({ constellation_id: 20000389, name: 'Kimotoro', region_id: 10000002 }),
  );

  insertSystem(db, 30002659, 'Dodixie', 20000389, 0.9);
  insertSystem(db, 30002660, 'Midpoint', 20000389, 0.5);
  insertSystem(db, 30002661, 'Scout Gate', 20000389, 0.1);
  insertSystem(db, 30000142, 'Jita', 20000389, 0.9);

  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    587,
    'Victim Ship',
    25,
    JSON.stringify({ type_id: 587, name: 'Victim Ship', group_id: 25 }),
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    603,
    'Attacker Ship',
    25,
    JSON.stringify({ type_id: 603, name: 'Attacker Ship', group_id: 25 }),
  );

  db.prepare(`INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at) VALUES (?, ?, ?, datetime('now'))`).run(
    'get_characters_character_id_location:2116626188:https://esi.evetech.net/latest/characters/2116626188/location/',
    JSON.stringify({ solar_system_id: 30002659 }),
    '2099-01-01 00:00:00',
  );
}

function insertSystem(
  db: Database.Database,
  systemId: number,
  name: string,
  constellationId: number,
  securityStatus: number,
): void {
  db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
    systemId,
    name,
    constellationId,
    JSON.stringify({
      system_id: systemId,
      name,
      constellation_id: constellationId,
      securityStatus,
      securityClass: securityStatus >= 0.5 ? 'A' : 'B',
    }),
  );
}
