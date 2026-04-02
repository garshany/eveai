import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { generateBriefing, generateBriefingFromSnapshot } from '../../src/eve-board/briefing.js';

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
  vi.useRealTimers();
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

  it('degrades gracefully when ship assessment data is missing or invalid', async () => {
    callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_universe_system_jumps') {
        return { ok: true, status: 200, cached: false, headers: {}, data: [] };
      }

      return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));

    const briefing = await generateBriefing(
      db,
      [30002659, 30002660, 30000142],
      'Dodixie',
      'Jita',
      2116626188,
      0,
    );

    expect(briefing).toContain('Корабль: неизвестен | Базовая оценка недоступна');
    expect(briefing).toContain('Оценка корпуса: данные о корабле недоступны.');
    expect(briefing).not.toContain('Корабль: #System');
    expect(briefing).not.toContain('Базовый EHP: 0');
    expect(briefing).not.toContain('Align: 0s');
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

  it('drops stale killmails whose actual killmail_time is older than the briefing window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T16:24:00Z'));

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
            killmail_time: '2026-04-02T14:59:00Z',
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
            killmail_id: 134200010,
            zkb: { hash: 'hash-stale', totalValue: 42000000, npc: false, solo: false },
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

    expect(briefing).toContain('Предполет | 🟢 ВЫХОДИ');
    expect(briefing).not.toContain('Активность:');
    expect(briefing).not.toContain('Последние киллы:');
    expect(briefing).not.toContain('Victim One');
  });

  it('treats destination-only activity as arrival intel instead of a transit threat ahead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T16:24:00Z'));

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
            killmail_time: '2026-04-02T15:28:00Z',
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
      if (typeof url === 'string' && url.includes('systemID/30000142')) {
        return {
          ok: true,
          json: async () => [{
            killmail_id: 134200011,
            zkb: { hash: 'hash-destination', totalValue: 12000000, npc: false, solo: false },
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

    expect(briefing).toContain('Впереди: Midpoint — транзит тихий; в Jita локально единичное убийство 56 мин назад.');
    expect(briefing).toContain('Анализ: старт тихий; между Dodixie и Jita транзитных PvP-точек нет; в цели Jita локально единичное убийство 56 мин назад.');
    expect(briefing).toContain('Jita [цель] — 56м назад');
    expect(briefing).not.toContain('Jita через 2 прыжка');
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

  it('builds pre-flight output from a shared route snapshot without rescanning the route', async () => {
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

      return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));

    const briefing = await generateBriefingFromSnapshot(
      db,
      [30002659, 30002660, 30000142],
      [
        {
          systemId: 30002659,
          name: 'Dodixie',
          sec: 0.9,
          kills_1h: 1,
          total_value_m: 66,
          recentKills: [{
            killmail_id: 134440041,
            killmail_time: '2026-04-02T13:45:00Z',
            total_value: 66_000_000,
            ship_name: 'Federation Navy Comet',
            victim_character_name: 'Logos Tr',
            final_blow_character_name: 'Osmon Queen',
            attacker_count: 1,
          }],
        },
      ],
      'Dodixie',
      'Jita',
      2116626188,
      587,
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(briefing).toContain('Сейчас: Dodixie');
    expect(briefing).toContain('Активность: Dodixie [старт]: 1 PvP');
    expect(briefing).toContain('Logos Tr <- Osmon Queen');
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
