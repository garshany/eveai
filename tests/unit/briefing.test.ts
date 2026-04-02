import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { generateBriefing } from '../../src/eve-board/briefing.js';

const { callEsiOperationMock } = vi.hoisted(() => ({
  callEsiOperationMock: vi.fn(),
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  seedRouteData(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('generateBriefing', () => {
  it('marks the route as non-safe when a scanned route system has PvP activity', async () => {
    callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_universe_system_jumps') {
        return {
          ok: true,
          status: 200,
          cached: false,
          headers: {},
          data: [
            { system_id: 30002659, ship_jumps: 17 },
            { system_id: 30002660, ship_jumps: 91 },
            { system_id: 30000142, ship_jumps: 120 },
          ],
        };
      }

      if (operation === 'get_killmails_killmail_id_killmail_hash') {
        return {
          ok: true,
          status: 200,
          cached: false,
          headers: {},
          data: {
            killmail_time: new Date().toISOString(),
            victim: { ship_type_id: 587 },
            attackers: [{ final_blow: true }],
          },
        };
      }

      return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('systemID/30002660')) {
        return {
          ok: true,
          json: async () => [{
            killmail_id: 134200001,
            zkb: { hash: 'hash-1', totalValue: 42000000, npc: false, solo: false },
          }],
        };
      }

      return { ok: true, json: async () => [] };
    }));

    const briefing = await generateBriefing(
      db,
      [30002659, 30002660, 30000142],
      'Dodixie',
      'Jita',
      2116626188,
      587,
    );

    expect(briefing).toContain('Предполет');
    expect(briefing).toContain('Сейчас:');
    expect(briefing).toContain('Впереди:');
    expect(briefing).toContain('Действие:');
    expect(briefing).toContain('Midpoint');
    expect(briefing).not.toContain('Маршрут безопасен. PvP активности не обнаружено.');
  });

  it('includes route analysis and recent kill details for active systems', async () => {
    callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_universe_system_jumps') {
        return {
          ok: true,
          status: 200,
          cached: false,
          headers: {},
          data: [
            { system_id: 30002659, ship_jumps: 17 },
            { system_id: 30002660, ship_jumps: 91 },
            { system_id: 30000142, ship_jumps: 120 },
          ],
        };
      }

      if (operation === 'get_killmails_killmail_id_killmail_hash') {
        return {
          ok: true,
          status: 200,
          cached: false,
          headers: {},
          data: {
            killmail_time: new Date().toISOString(),
            victim: { ship_type_id: 587, character_id: 9001 },
            attackers: [{ character_id: 9002, final_blow: true }],
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
            { id: 9002, name: 'Attacker One' },
          ],
        };
      }

      return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('systemID/30002660')) {
        return {
          ok: true,
          json: async () => [{
            killmail_id: 134200002,
            zkb: { hash: 'hash-2', totalValue: 42000000, npc: false, solo: false },
          }],
        };
      }

      return { ok: true, json: async () => [] };
    }));

    const briefing = await generateBriefing(
      db,
      [30002659, 30002660, 30000142],
      'Dodixie',
      'Jita',
      2116626188,
      587,
    );

    expect(briefing).toContain('Анализ:');
    expect(briefing).toContain('Последние киллы:');
    expect(briefing).toContain('Victim One <- Attacker One');
  });

  it('scans the whole selected route instead of truncating a late dangerous system', async () => {
    for (let i = 0; i < 10; i++) {
      insertSystem(db, 30003000 + i, `Route ${i + 1}`, 20000389, 0.9);
    }
    insertSystem(db, 30004000, 'Late Danger', 20000389, 0.8);

    callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_universe_system_jumps') {
        return { ok: true, status: 200, cached: false, headers: {}, data: [] };
      }

      if (operation === 'get_killmails_killmail_id_killmail_hash') {
        return {
          ok: true,
          status: 200,
          cached: false,
          headers: {},
          data: {
            killmail_time: new Date().toISOString(),
            victim: { ship_type_id: 587 },
            attackers: [{ final_blow: true }],
          },
        };
      }

      return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('systemID/30004000')) {
        return {
          ok: true,
          json: async () => [{
            killmail_id: 134200099,
            zkb: { hash: 'hash-late', totalValue: 99000000, npc: false, solo: false },
          }],
        };
      }

      return { ok: true, json: async () => [] };
    }));

    const routeSystems = [
      30002659,
      30003000,
      30003001,
      30003002,
      30003003,
      30003004,
      30003005,
      30003006,
      30003007,
      30003008,
      30003009,
      30004000,
      30000142,
    ];

    const briefing = await generateBriefing(
      db,
      routeSystems,
      'Dodixie',
      'Jita',
      2116626188,
      587,
    );

    expect(briefing).toContain('Late Danger');
    expect(briefing).toContain('Предполет');
    expect(briefing).toContain('Впереди:');
    expect(briefing).not.toContain('Маршрут безопасен. PvP активности не обнаружено.');
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
  insertSystem(db, 30000142, 'Jita', 20000389, 0.9);
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
    }),
  );
}
