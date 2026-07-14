import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const { buildRouteThreatSnapshotMock, callEsiOperationMock } = vi.hoisted(() => ({
  buildRouteThreatSnapshotMock: vi.fn(),
  callEsiOperationMock: vi.fn(),
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

vi.mock('../../src/eve-board/route-snapshot.js', () => ({
  buildRouteThreatSnapshot: buildRouteThreatSnapshotMock,
}));

import { generateBriefing, generateBriefingFromSnapshot } from '../../src/eve-board/briefing.js';

let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  seedRouteData(db);
  setSnapshot([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  db.close();
});

describe('generateBriefing', () => {
  it('marks the route as non-safe when the shared baseline has PvP activity', async () => {
    setSnapshot([
      snapshotSystem(30002660, 'Midpoint', 0.5, [{
        killmail_id: 134200001,
        killmail_time: new Date().toISOString(),
        total_value: 42_000_000,
        ship_type_id: 587,
        attacker_count: 1,
      }]),
    ]);

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
    expect(briefing).toContain('Тактика:');
    expect(briefing).toContain('Действие:');
    expect(briefing).toContain('Midpoint');
    expect(briefing).not.toContain('Маршрут безопасен. PvP активности не обнаружено.');
  });

  it('degrades gracefully when ship assessment data is missing or invalid', async () => {
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
    setSnapshot([
      snapshotSystem(30002660, 'Midpoint', 0.5, [{
        killmail_id: 134200002,
        killmail_time: new Date().toISOString(),
        total_value: 42_000_000,
        ship_type_id: 587,
        ship_name: 'Victim Ship',
        victim_character_name: 'Victim One',
        final_blow_character_name: 'Attacker One',
        attacker_count: 1,
      }]),
    ]);

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
    expect(briefing).toContain('Victim One ← Attacker One');
  });

  it('renders a quiet route when the one-hour baseline excludes stale kills', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T16:24:00Z'));
    setSnapshot([], [30002659, 30002660, 30000142], '2026-04-02T16:24:00Z');

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
    setSnapshot([
      snapshotSystem(30000142, 'Jita', 0.9, [{
        killmail_id: 134200011,
        killmail_time: '2026-04-02T15:28:00Z',
        total_value: 12_000_000,
        ship_type_id: 587,
        ship_name: 'Victim Ship',
        victim_character_name: 'Victim One',
        final_blow_character_name: 'Attacker One',
        attacker_count: 1,
      }]),
    ], [30002659, 30002660, 30000142], '2026-04-02T16:24:00Z');

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
    for (let index = 0; index < 10; index += 1) {
      insertSystem(db, 30003000 + index, `Route ${index + 1}`, 20000389, 0.9);
    }
    insertSystem(db, 30004000, 'Late Danger', 20000389, 0.8);
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
    setSnapshot([
      snapshotSystem(30004000, 'Late Danger', 0.8, [{
        killmail_id: 134200099,
        killmail_time: new Date().toISOString(),
        total_value: 99_000_000,
        ship_type_id: 587,
        attacker_count: 1,
      }]),
    ], routeSystems);

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
    vi.stubGlobal('fetch', vi.fn());

    const briefing = await generateBriefingFromSnapshot(
      db,
      [30002659, 30002660, 30000142],
      [{
        systemId: 30002659,
        name: 'Dodixie',
        sec: 0.9,
        kills_1h: 1,
        total_value_m: 66,
        recentKills: [{
          killmail_id: 134440041,
          killmail_time: new Date().toISOString(),
          total_value: 66_000_000,
          ship_name: 'Federation Navy Comet',
          victim_character_name: 'Logos Tr',
          final_blow_character_name: 'Osmon Queen',
          attacker_count: 1,
        }],
      }],
      'Dodixie',
      'Jita',
      2116626188,
      587,
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(briefing).toContain('Сейчас: Dodixie');
    expect(briefing).toContain('Активность: Dodixie [старт]: 1 PvP');
    expect(briefing).toContain('Logos Tr ← Osmon Queen');
  });
});

type SnapshotKill = {
  killmail_id: number;
  killmail_time: string;
  total_value?: number;
  ship_type_id?: number;
  ship_name?: string;
  victim_character_name?: string;
  final_blow_character_name?: string;
  attacker_count?: number;
};

function snapshotSystem(
  systemId: number,
  name: string,
  sec: number,
  kills: SnapshotKill[],
) {
  return {
    systemId,
    routeIndex: 0,
    name,
    sec,
    pvpKills: kills.length,
    npcKills: 0,
    totalValueM: Math.round(kills.reduce((sum, kill) => sum + (kill.total_value ?? 0), 0) / 1_000_000),
    valueResolvedKills: kills.filter((kill) => kill.total_value !== undefined).length,
    recentKills: kills.map((kill) => ({
      ...kill,
      eve_kill_url: `https://eve-kill.com/kill/${kill.killmail_id}`,
      time_msk: kill.killmail_time,
    })),
    gateKills: [],
  };
}

function setSnapshot(
  systems: ReturnType<typeof snapshotSystem>[],
  routeSystems = [30002659, 30002660, 30000142],
  scannedAt = new Date().toISOString(),
): void {
  buildRouteThreatSnapshotMock.mockResolvedValue({
    routeSystems,
    systems,
    jumpMap: new Map<number, number>(),
    totalKills: systems.reduce((sum, system) => sum + system.pvpKills, 0),
    totalValueM: systems.reduce((sum, system) => sum + system.totalValueM, 0),
    truncated: false,
    requestCount: 1,
    error: null,
    scannedAt,
  });
}

function seedRouteData(database: Database.Database): void {
  database.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)').run(
    10000002,
    'The Forge',
    JSON.stringify({ region_id: 10000002, name: 'The Forge' }),
  );
  database.prepare(
    'INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)',
  ).run(
    20000389,
    'Kimotoro',
    10000002,
    JSON.stringify({ constellation_id: 20000389, name: 'Kimotoro', region_id: 10000002 }),
  );

  insertSystem(database, 30002659, 'Dodixie', 20000389, 0.9);
  insertSystem(database, 30002660, 'Midpoint', 20000389, 0.5);
  insertSystem(database, 30000142, 'Jita', 20000389, 0.9);
}

function insertSystem(
  database: Database.Database,
  systemId: number,
  name: string,
  constellationId: number,
  securityStatus: number,
): void {
  database.prepare(
    'INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)',
  ).run(
    systemId,
    name,
    constellationId,
    JSON.stringify({ system_id: systemId, name, constellation_id: constellationId, securityStatus }),
  );
}
