import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import type { Advisory } from '../../src/eve-map/advisor.js';

const esiMock = vi.hoisted(() => vi.fn(async () => ({ ok: false as const, status: 503, error: 'offline in test' })));
const scoutMock = vi.hoisted(() => vi.fn(async () => ({ ok: false as const, error: 'offline in test' })));
const searchMock = vi.hoisted(() => vi.fn(async () => ({ ok: false as const, error: 'offline in test' })));

vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: esiMock }));
vi.mock('../../src/eve/eve-scout-client.js', () => ({ getSignatures: scoutMock }));
vi.mock('../../src/eve-kill/client.js', () => ({ searchKillmails: searchMock }));

const { buildMapGraph, invalidateMapGraphCache } = await import('../../src/eve/map-graph.js');
const { executePerimeterTool, isPerimeterTool, PERIMETER_TOOLS } = await import('../../src/eve-map/tools.js');
const { recordKillmail } = await import('../../src/eve-map/kill-index.js');
const { getActiveRoute, resetActiveRoutesForTests } = await import('../../src/eve-map/active-route.js');
const {
  appendAdvisory,
  getOrCreatePerimeterThread,
  perimeterThreadTitle,
  readPerimeterHistory,
} = await import('../../src/eve-map/thread.js');

const NOW = Date.now();

function seedGraph(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  db.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('1', '2026-01-01');
  db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)').run(1, 'R', '{}');
  db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)').run(1, 'C', 1, '{}');
  const insert = db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)');
  insert.run(30000001, 'Alpha', 1, JSON.stringify({ securityStatus: 0.9, position2D: { x: 0, y: 0 } }));
  insert.run(30000002, 'Beta', 1, JSON.stringify({ securityStatus: 0.4, position2D: { x: 10, y: 0 } }));
  db.prepare('INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, ?, ?)')
    .run(1, 30000001, 30000002, null, '{}');
  buildMapGraph(db, { force: true });
}

describe('perimeter tools', () => {
  let db: Database.Database;

  beforeEach(() => {
    invalidateMapGraphCache();
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    seedGraph(db);
  });

  afterEach(() => {
    db.close();
    invalidateMapGraphCache();
  });

  it('exposes exactly the four documented tools', () => {
    expect(PERIMETER_TOOLS.map((tool) => tool.name).sort()).toEqual([
      'compare_ships', 'map_bubble_intel', 'route_risk', 'threat_explain',
    ]);
    for (const tool of PERIMETER_TOOLS) {
      expect(isPerimeterTool(tool.name)).toBe(true);
      expect(tool.strict).toBe(true);
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    expect(isPerimeterTool('plan_route')).toBe(false);
  });

  it('rejects arguments that the schema would have allowed a cooperative caller to send', async () => {
    // Строгая схема — договор с добросовестным вызывающим, а не гарантия.
    const bad = await executePerimeterTool(db, 'map_bubble_intel', { system_id: 'Jita' });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain('system_id');
  });

  it('refuses a system that is not in the graph instead of returning an empty map', async () => {
    const result = await executePerimeterTool(db, 'map_bubble_intel', {
      system_id: 42, radius: null, ship_type_id: null,
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('map graph');
  });

  it('returns a bounded bubble payload with its freshness markers', async () => {
    const result = await executePerimeterTool(db, 'map_bubble_intel', {
      system_id: 30000001, radius: 2, ship_type_id: null,
    });
    expect(result.ok).toBe(true);
    expect(result.system_count).toBe(2);
    expect(Array.isArray(result.freshness)).toBe(true);
    // Часовой фон ESI отдаётся отдельным полем и не смешивается с живыми килами.
    const systems = result.systems as Array<Record<string, unknown>>;
    expect(systems[0]).toHaveProperty('esi_baseline_ship_kills_1h');
    expect(systems[0]).toHaveProperty('danger_terms');
  });

  it('reports how much of a route the danger data actually covered', async () => {
    const result = await executePerimeterTool(db, 'route_risk', {
      origin_system_id: 30000001,
      destination_system_id: 30000002,
      mode: 'shortest',
      risk_weight: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.jumps).toBe(1);
    expect(result.shortest_jumps).toBe(1);
    const coverage = result.danger_coverage as Record<string, unknown>;
    // Маршрут без покрытия выглядит увереннее, чем он есть.
    expect(coverage.total_systems).toBe(2);
    expect(String(coverage.note)).toContain('not "safe"');
  });

  it('explains a system with the actual killmails', async () => {
    recordKillmail(db, {
      killmailId: 1,
      killmailTime: new Date(NOW - 120_000).toISOString(),
      solarSystemId: 30000002,
      totalValue: 250_000_000,
      attackerCount: 3,
      isNpc: false,
      isSolo: false,
      victim: { characterName: 'Prey', shipName: 'Badger' },
      attackers: [{ characterId: 5, characterName: 'Ganker', shipName: 'Catalyst', finalBlow: true }],
      items: [],
      siblings: [],
      sourceShape: 'feed',
    } as never, 'feed', NOW);
    recordKillmail(db, {
      killmailId: 2,
      killmailTime: new Date(NOW - 60_000).toISOString(),
      solarSystemId: 30000002,
      totalValue: 90_000_000,
      attackerCount: 2,
      isNpc: false,
      isSolo: false,
      victim: { characterName: 'Prey2', shipName: 'Iteron' },
      attackers: [{ characterId: 5, characterName: 'Ganker', shipName: 'Catalyst', finalBlow: true }],
      items: [],
      siblings: [],
      sourceShape: 'feed',
    } as never, 'feed', NOW);

    const result = await executePerimeterTool(db, 'threat_explain', { system_id: 30000002 });
    expect(result.ok).toBe(true);
    expect(result.kill_count).toBe(2);
    const repeats = result.repeat_attackers as Array<Record<string, unknown>>;
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.name).toBe('Ganker');
    const kills = result.kills as Array<Record<string, unknown>>;
    expect(kills[0]!.url).toContain('eve-kill.com/kill/');
  });

  it('says plainly when nothing has died in a system', async () => {
    const result = await executePerimeterTool(db, 'threat_explain', { system_id: 30000001 });
    expect(result.ok).toBe(true);
    expect(result.kill_count).toBe(0);
    expect(result.kills).toEqual([]);
    // Пустой ответ должен объяснять, за какое окно он пустой.
    expect(String(result.coverage_note)).toContain('retained');
    // История кемпов и трафик — отдельные слои, они есть даже когда килов нет.
    expect(result.gate_camp_history).toEqual([]);
    expect((result.traffic as Record<string, unknown>).available).toBe(false);
  });

  it('rejects an unknown tool name', async () => {
    const result = await executePerimeterTool(db, 'not_a_tool', {});
    expect(result.ok).toBe(false);
  });
});

describe('perimeter thread', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'tester')").run();
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (-2000000000, 'web')").run();
  });

  afterEach(() => db.close());

  function advisory(overrides: Partial<Advisory> = {}): Advisory {
    return {
      rule: 'camp_next_hop',
      severity: 'danger',
      text: { ru: 'Кемп в Uedama', en: 'Camp in Uedama' },
      systemId: 30000002,
      killmailId: 4242,
      repeats: 2,
      at: new Date(NOW).toISOString(),
      ...overrides,
    };
  }

  it('reuses one thread per character instead of opening a new one each time', () => {
    const first = getOrCreatePerimeterThread(db, -2_000_000_000, 1, 90_000_001);
    const second = getOrCreatePerimeterThread(db, -2_000_000_000, 1, 90_000_001);
    expect(second).toBe(first);

    // Другой персонаж — другой транскрипт: предупреждения двух пилотов не
    // должны смешиваться.
    const other = getOrCreatePerimeterThread(db, -2_000_000_000, 1, 90_000_002);
    expect(other).not.toBe(first);
  });

  it('marks the thread so the workspace can tell it apart', () => {
    const threadId = getOrCreatePerimeterThread(db, -2_000_000_000, 1, null);
    const row = db.prepare('SELECT kind FROM agent_threads WHERE thread_id = ?').get(threadId) as { kind: string };
    expect(row.kind).toBe('perimeter');
  });

  it('persists an advisory with its anchor so the message stays clickable', () => {
    const threadId = getOrCreatePerimeterThread(db, -2_000_000_000, 1, null);
    const message = appendAdvisory(db, threadId, advisory(), 'ru');

    expect(message.content).toBe('Кемп в Uedama');
    expect(message.meta).toMatchObject({
      rule: 'camp_next_hop',
      severity: 'danger',
      systemId: 30000002,
      killmailId: 4242,
      repeats: 2,
      authored: 'rule',
    });

    const history = readPerimeterHistory(db, threadId);
    expect(history).toHaveLength(1);
    expect(history[0]!.meta?.rule).toBe('camp_next_hop');
  });

  it('writes the locale the viewer asked for', () => {
    const threadId = getOrCreatePerimeterThread(db, -2_000_000_000, 1, null);
    const message = appendAdvisory(db, threadId, advisory(), 'en');
    expect(message.content).toBe('Camp in Uedama');
  });

  it('returns history oldest first', () => {
    const threadId = getOrCreatePerimeterThread(db, -2_000_000_000, 1, null);
    appendAdvisory(db, threadId, advisory({ text: { ru: 'первое', en: 'first' } }), 'ru');
    appendAdvisory(db, threadId, advisory({ text: { ru: 'второе', en: 'second' } }), 'ru');

    const history = readPerimeterHistory(db, threadId);
    expect(history.map((message) => message.content)).toEqual(['первое', 'второе']);
  });

  it('titles a thread that opens with an assistant message', () => {
    const threadId = getOrCreatePerimeterThread(db, -2_000_000_000, 1, null);
    appendAdvisory(db, threadId, advisory(), 'ru');
    // Иначе в списке диалогов каждый полёт называется «Новый диалог».
    expect(perimeterThreadTitle(db, threadId, 'ru')).toBe('Периметр');

    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)")
      .run(threadId, 'стоит ли лететь через Uedama?');
    expect(perimeterThreadTitle(db, threadId, 'ru')).toBe('стоит ли лететь через Uedama?');
  });

  it('leaves ordinary chat messages without advisory metadata', () => {
    const threadId = getOrCreatePerimeterThread(db, -2_000_000_000, 1, null);
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', 'привет')").run(threadId);
    const history = readPerimeterHistory(db, threadId);
    expect(history[0]!.meta).toBeNull();
  });
});

/**
 * Регрессия на реальную жалобу: линия на карте показывала не тот маршрут, что
 * рекомендовал лоцман. route_risk публиковал КАЖДЫЙ вызов, поэтому сравнение
 * «secure против insecure» оставляло на экране последний сравнённый вариант, а
 * в ответе стоял первый.
 */
describe('route_risk draws only the route it recommends', () => {
  const LANE = -2_000_000_777;
  let db: Database.Database;

  beforeEach(() => {
    resetActiveRoutesForTests();
    invalidateMapGraphCache();
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    seedGraph(db);
  });

  afterEach(() => {
    resetActiveRoutesForTests();
    db.close();
    invalidateMapGraphCache();
  });

  const plan = (draw: unknown): Promise<Record<string, unknown>> => executePerimeterTool(db, 'route_risk', {
    origin_system_id: 30000001,
    destination_system_id: 30000002,
    mode: 'shortest',
    risk_weight: 0,
    draw_on_map: draw,
  }, LANE);

  it('redraws the line when this is the recommendation', async () => {
    const result = await plan(true);
    expect(result.ok).toBe(true);
    expect(getActiveRoute(LANE)?.systemIds).toEqual([30000001, 30000002]);
  });

  it('leaves the pilot line alone when merely comparing', async () => {
    const result = await plan(false);
    expect(result.ok).toBe(true);
    expect(getActiveRoute(LANE)).toBeNull();
  });

  it('treats a missing flag as "do not draw"', async () => {
    // Строгая схема — это договор с добросовестным вызывающим, а не гарантия.
    await executePerimeterTool(db, 'route_risk', {
      origin_system_id: 30000001,
      destination_system_id: 30000002,
      mode: 'shortest',
      risk_weight: 0,
    }, LANE);
    expect(getActiveRoute(LANE)).toBeNull();
  });

  it('a later comparison does not overwrite the recommended route', async () => {
    await plan(true);
    await executePerimeterTool(db, 'route_risk', {
      origin_system_id: 30000002,
      destination_system_id: 30000001,
      mode: 'shortest',
      risk_weight: 0,
      draw_on_map: false,
    }, LANE);
    // Именно это и было багом: пилот смотрел на последний сравнённый маршрут.
    expect(getActiveRoute(LANE)?.systemIds).toEqual([30000001, 30000002]);
  });

  it('a route that could not be planned never redraws the line', async () => {
    const result = await executePerimeterTool(db, 'route_risk', {
      origin_system_id: 30000001,
      destination_system_id: 39999999,
      mode: 'shortest',
      risk_weight: 0,
      draw_on_map: true,
    }, LANE);
    expect(result.ok).toBe(false);
    expect(getActiveRoute(LANE)).toBeNull();
  });

  it('declares draw_on_map as a required property, not an optional one', () => {
    const tool = PERIMETER_TOOLS.find((entry) => entry.name === 'route_risk')!;
    const parameters = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    // Свойство вне required в strict-схеме — ошибка контракта, а не стиля.
    expect(parameters.properties).toHaveProperty('draw_on_map');
    expect(parameters.required).toContain('draw_on_map');
  });
});
