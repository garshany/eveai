import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const callEsiOperationMock = vi.fn();
const getLinkedCharacterMock = vi.fn();

vi.mock('../../src/config.js', () => ({
  config: {
    zkill: {
      baseUrl: 'https://zkillboard.com/api/',
      timeoutMs: 5000,
    },
  },
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

vi.mock('../../src/eve/sso.js', () => ({
  getLinkedCharacter: getLinkedCharacterMock,
}));

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  seedRouteData(db);

  getLinkedCharacterMock.mockReturnValue({ characterId: 2116626188 });

  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('systemID/30002660/pastSeconds/3600/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          killmail_id: 134200001,
          zkb: {
            hash: 'hash-midpoint',
            totalValue: 42000000,
            npc: false,
          },
        }]),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      json: async () => ([]),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock as typeof fetch);

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  callEsiOperationMock.mockImplementation(async (_db, operation, args) => {
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

    if (operation === 'get_killmails_killmail_id_killmail_hash') {
      return {
        ok: true,
        status: 200,
        cached: false,
        headers: {},
        data: {
          killmail_time: '2026-03-22T10:15:00Z',
          victim: {
            character_id: 9001,
            corporation_id: 9101,
            ship_type_id: 587,
          },
          attackers: [
            {
              character_id: 9201,
              corporation_id: 9301,
              ship_type_id: 603,
              final_blow: true,
            },
          ],
        },
      };
    }

    if (operation === 'post_universe_names') {
      return {
        ok: true,
        status: 200,
        cached: false,
        headers: {},
        data: [
          { id: 9001, name: 'Victim One' },
          { id: 9101, name: 'Victim Corp' },
          { id: 9201, name: 'Attacker One' },
          { id: 9301, name: 'Attacker Corp' },
        ],
      };
    }

    return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
  });
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  vi.unstubAllGlobals();
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
    expect(result.formatted_summary).toContain('Автопилот: нет');
    expect(result.formatted_summary).toContain('Риск: средний');
    expect(result.formatted_summary).toContain('<code>route     jumps min  kills isk');
    expect(result.formatted_summary).toContain('secure    2');
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
    expect(result.formatted_summary).toContain('Автопилот: выставлен');
    expect(result.formatted_summary).toContain('<code>route     jumps min  kills isk');
    expect(result.formatted_summary).toContain('<b>Основной маршрут</b> (secure): <b>Dodixie</b> → <b>Midpoint</b> → <b>Jita</b>');
    expect(result.formatted_summary).toContain('Альтернативы: shortest 1j min 0.9 | insecure 2j min 0.1');
    expect(result.formatted_summary).toContain('<b>Опасные системы по всем вариантам</b>');
    expect(result.formatted_summary).toContain('<b>Midpoint</b> 0.5 | маршруты: secure | 1 kills | PvP 1 | 42M ISK');
    expect(result.formatted_summary).toContain('Victim One');
    expect(result.formatted_summary).toContain('Attacker One');
    expect(result.formatted_summary).toContain('<a href="https://zkillboard.com/kill/134200001/">zKill</a>');
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
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('systemID/30002659/pastSeconds/3600/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([{
            killmail_id: 134200010,
            zkb: {
              hash: 'hash-dodixie',
              totalValue: 42000000,
              npc: false,
            },
          }]),
        } as unknown as Response;
      }
      if (url.includes('systemID/30002660/pastSeconds/3600/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([{
            killmail_id: 134200011,
            zkb: {
              hash: 'hash-midpoint',
              totalValue: 42000000,
              npc: false,
            },
          }]),
        } as unknown as Response;
      }
      if (url.includes('systemID/30002661/pastSeconds/3600/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([{
            killmail_id: 134200012,
            zkb: {
              hash: 'hash-scout',
              totalValue: 42000000,
              npc: false,
            },
          }]),
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ([]),
      } as unknown as Response;
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
    expect(result.formatted_summary).toContain('опасных систем: 2, киллов за 1ч: 2, потери: 84M ISK');
    expect(result.formatted_summary).toContain('<b>Dodixie</b> 0.9 | маршруты: secure, shortest, insecure | 1 kills | PvP 1 | 42M ISK');
    expect(result.formatted_summary).toContain('<b>Scout Gate</b> 0.1 | маршруты: insecure | 1 kills | PvP 1 | 42M ISK');
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
