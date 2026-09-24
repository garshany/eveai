import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

/**
 * Регрессия на реальную жалобу: «на большой карте красные зоны, нули типа, по
 * ним по нажатию не открывается ничего».
 *
 * Экран искал выбранную систему только в пузыре радиуса 5, а холст всей карты
 * выбирает любую из ~8490. Эндпоинт при этом отдавал одну геометрию — ни
 * оценки опасности, ни активности, ни кемпов, — так что показывать инспектору
 * было нечего даже после починки поиска.
 */

const esiMock = vi.hoisted(() => vi.fn(async () => ({ ok: false as const, status: 503, error: 'offline in test' })));
const scoutMock = vi.hoisted(() => vi.fn(async () => ({ ok: false as const, error: 'offline in test' })));
const searchMock = vi.hoisted(() => vi.fn(async () => ({ ok: false as const, error: 'offline in test' })));

vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: esiMock }));
vi.mock('../../src/eve/eve-scout-client.js', () => ({ getSignatures: scoutMock }));
vi.mock('../../src/eve-kill/client.js', () => ({ searchKillmails: searchMock }));
vi.mock('../../src/eve-kill/feed-poll.js', () => ({
  subscribeEveKillFeed: vi.fn(() => vi.fn()),
  getEveKillFeedRuntimeStatus: vi.fn(() => ({ running: false, lastPollAt: null, lastSuccessAt: null, lastError: null })),
}));

const { buildMapGraph, invalidateMapGraphCache } = await import('../../src/eve/map-graph.js');
const { registerMapRoutes } = await import('../../src/web/map-routes.js');
const { recordKillmail } = await import('../../src/eve-map/kill-index.js');
const { createWebSession, resetWebSessionCreationGuardForTests, WEB_SESSION_COOKIE } =
  await import('../../src/web/web-session.js');
type Coordinator = Parameters<typeof registerMapRoutes>[2];

const NEAR = 30000001;
const MID = 30000002;
const FAR = 30000003;

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let cookie: string;

function seedGraph(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  database.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('1', 'now');
  database.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (1, ?, ?)').run('Region', '{}');
  database.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (1, ?, 1, ?)')
    .run('Constellation', '{}');
  const system = database.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
  system.run(NEAR, 'Near', JSON.stringify({ securityStatus: 0.9, position2D: { x: 0, y: 0 } }));
  system.run(MID, 'Mid', JSON.stringify({ securityStatus: 0.4, position2D: { x: 10, y: 0 } }));
  // Нулевая система на другом конце — та самая, по которой не открывалось ничего.
  system.run(FAR, 'Deep', JSON.stringify({ securityStatus: -0.9, position2D: { x: 20, y: 0 } }));
  const gate = database.prepare('INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, NULL, ?)');
  gate.run(1, NEAR, MID, '{}');
  gate.run(2, MID, NEAR, '{}');
  gate.run(3, MID, FAR, '{}');
  gate.run(4, FAR, MID, '{}');
  buildMapGraph(database, { force: true });
}

beforeEach(async () => {
  invalidateMapGraphCache();
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  seedGraph(db);
  resetWebSessionCreationGuardForTests();
  app = Fastify();
  await app.register(fastifyCookie);
  registerMapRoutes(app, db, { enqueue: () => { throw new Error('unused'); } } as unknown as Coordinator);
  cookie = `${WEB_SESSION_COOKIE}=${createWebSession(db).sessionToken}`;
});

afterEach(async () => {
  await app.close();
  db.close();
  invalidateMapGraphCache();
});

async function inspect(systemId: number, from?: number) {
  const query = from === undefined ? `system_id=${systemId}` : `system_id=${systemId}&from_system_id=${from}`;
  const response = await app.inject({ method: 'GET', url: `/api/web/map/system?${query}`, headers: { cookie } });
  return response;
}

describe('GET /api/web/map/system answers for any system, not just the bubble', () => {
  it('returns the full rollup for a system far outside the pilot bubble', async () => {
    recordKillmail(db, {
      killmailId: 77,
      killmailTime: new Date().toISOString(),
      solarSystemId: FAR,
      totalValue: 900_000_000,
      attackerCount: 4,
      isNpc: false,
      isSolo: false,
      victim: { characterId: 1, corporationId: 2, allianceId: null, shipTypeId: 587 },
      attackers: [{ characterId: 3, corporationId: 4, allianceId: null, shipTypeId: 603, finalBlow: true }],
    });

    const response = await inspect(FAR, NEAR);
    expect(response.statusCode).toBe(200);
    const system = response.json().system as Record<string, unknown>;

    // Всё, что рисует инспектор: без этого панель открывалась бы пустой.
    expect(system.name).toBe('Deep');
    expect(system).toHaveProperty('danger');
    expect(system).toHaveProperty('activity');
    expect(system).toHaveProperty('gateCamps');
    expect((system.danger as { terms: unknown[] }).terms).toBeInstanceOf(Array);
    expect((system.activity as { kills1h: number }).kills1h).toBe(1);
  });

  it('measures distance from where the pilot actually is', async () => {
    expect((await inspect(FAR, NEAR)).json().system.jumps).toBe(2);
    expect((await inspect(MID, NEAR)).json().system.jumps).toBe(1);
    expect((await inspect(NEAR, NEAR)).json().system.jumps).toBe(0);
  });

  it('says the distance is unknown rather than answering zero', async () => {
    // 0 прочиталось бы как «ты здесь» — для системы на другом конце кластера
    // это худший из возможных ответов.
    expect((await inspect(FAR)).json().system.jumps).toBeNull();
  });

  it('reports no distance when the two systems are not connected', async () => {
    // Отдельная компонента графа: «неизвестно» честнее, чем любое число.
    db.prepare('INSERT INTO map_systems (system_id, name, security, map_x, map_y) VALUES (?, ?, ?, ?, ?)')
      .run(30009999, 'Island', 0.5, 999, 999);
    expect((await inspect(FAR, 30009999)).json().system.jumps).toBeNull();
  });

  it('still 404s for a system that is not in the graph', async () => {
    expect((await inspect(39999999, NEAR)).statusCode).toBe(404);
  });
});
