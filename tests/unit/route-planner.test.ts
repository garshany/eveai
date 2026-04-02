import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const callEsiOperationMock = vi.fn();
const getLinkedCharacterMock = vi.fn();
const { generateBriefingFromSnapshotMock } = vi.hoisted(() => ({
  generateBriefingFromSnapshotMock: vi.fn().mockResolvedValue(''),
  generateBriefingMock: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

vi.mock('../../src/eve/sso.js', () => ({
  getLinkedCharacter: getLinkedCharacterMock,
}));

// Mock eve-board modules to prevent import issues
vi.mock('../../src/eve-board/monitor.js', () => ({
  startRouteMonitor: vi.fn(),
}));
vi.mock('../../src/eve-board/briefing.js', () => ({
  generateBriefing: vi.fn(),
  generateBriefingFromSnapshot: generateBriefingFromSnapshotMock,
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
  generateBriefingFromSnapshotMock.mockResolvedValue('');

  // Mock global fetch for zKB danger scan — return kills only for Midpoint (30002660)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('systemID/30002660')) {
      return {
        ok: true,
        json: async () => [{
          killmail_id: 134200001,
          zkb: { hash: 'abc123', totalValue: 42000000, npc: false, solo: false },
        }],
      };
    }
    // Other systems or URLs: empty array
    return { ok: true, json: async () => [] };
  }));

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

    if (operation === 'get_killmails_killmail_id_killmail_hash') {
      return {
        ok: true, status: 200, cached: false, headers: {},
        data: {
          killmail_time: new Date().toISOString(),
          solar_system_id: 30002660,
          victim: { character_id: 9001, corporation_id: 9101, ship_type_id: 587 },
          attackers: [{ character_id: 9201, corporation_id: 9301, ship_type_id: 603, final_blow: true }],
        },
      };
    }

    if (operation === 'post_universe_names') {
      return {
        ok: true, status: 200, cached: false, headers: {},
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
  vi.useRealTimers();
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
    expect(result.formatted_summary).toContain('Выбран: secure');
    expect(result.formatted_summary).toContain('прыжков');
    expect(result.formatted_summary).toContain('secure');
    expect(result.formatted_summary).toContain('Ключевые точки');
    expect(result.formatted_summary).toContain('zKB срез:');
    expect(result.formatted_summary).not.toContain('<b>Опасные системы</b>');
  });

  it('can append the unified pre-flight brief even when autopilot is not enabled', async () => {
    generateBriefingFromSnapshotMock.mockResolvedValue('🛰️ Предполет | 🟡 ОСТОРОЖНО');

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
    expect(result.autopilot_set).toBe(false);
    expect(result.formatted_summary).toContain('🛰️ Предполет | 🟡 ОСТОРОЖНО');
  });

  it('returns a compact route summary and appends the unified pre-flight brief', async () => {
    generateBriefingFromSnapshotMock.mockResolvedValue([
      '🛰️ Предполет | 🟢 ВЫХОДИ',
      'Маршрут: Dodixie → Jita (2 прыжков)',
      'Сейчас: Dodixie — локально тихо.',
      'Впереди: Midpoint через 1 прыжок — свежих PvP-угроз не видно.',
      'Действие: можно выходить.',
    ].join('\n'));

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
    expect(result.formatted_summary).toContain('Ключевые точки');
    expect(result.formatted_summary).toContain('zKB срез:');
    expect(result.formatted_summary).toContain('🛰️ Предполет | 🟢 ВЫХОДИ');
    expect(result.formatted_summary).toContain('Сейчас: Dodixie');
    expect(result.formatted_summary).not.toContain('<b>Опасные системы</b>');
    expect(result.formatted_summary).toContain('zkb</a>');
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

  it('keeps the summary focused on the selected route instead of merged danger coverage', async () => {
    // Kills in multiple systems via zKB mock
    const mkZkbKill = (id: number) => ({
      killmail_id: id,
      zkb: { hash: `hash${id}`, totalValue: 42000000, npc: false, solo: false },
    });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('systemID/30002659')) {
        return { ok: true, json: async () => [mkZkbKill(134200010)] };
      }
      if (typeof url === 'string' && url.includes('systemID/30002660')) {
        return { ok: true, json: async () => [mkZkbKill(134200011)] };
      }
      if (typeof url === 'string' && url.includes('systemID/30002661')) {
        return { ok: true, json: async () => [mkZkbKill(134200012)] };
      }
      return { ok: true, json: async () => [] };
    }));

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
    expect(result.formatted_summary).toContain('Ключевые точки');
    expect(result.formatted_summary).toContain('zKB срез:');
    expect(result.formatted_summary).toContain('Midpoint');
    expect(result.formatted_summary).not.toContain('Scout Gate');
    expect(result.formatted_summary).not.toContain('[insecure]');
  });

  it('drops stale route-planner kills from the selected route summary and shows a clean zKB snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T16:24:00Z'));

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

      if (operation === 'get_killmails_killmail_id_killmail_hash') {
        return {
          ok: true, status: 200, cached: false, headers: {},
          data: {
            killmail_time: '2026-04-02T14:59:00Z',
            solar_system_id: 30002660,
            victim: { character_id: 9001, corporation_id: 9101, ship_type_id: 587 },
            attackers: [{ character_id: 9201, corporation_id: 9301, ship_type_id: 603, final_blow: true }],
          },
        };
      }

      if (operation === 'post_universe_names') {
        return {
          ok: true, status: 200, cached: false, headers: {},
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
    expect(result.formatted_summary).toContain('киллов/ч: 0');
    expect(result.formatted_summary).toContain('zKB срез: на выбранной трассе свежих killmail за последний час не видно.');
    expect(result.formatted_summary).not.toContain('Victim One');
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
