import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { registerMapRoutes } from '../../src/web/map-routes.js';
import {
  getActiveRoute,
  rememberRoute,
  resetActiveRoutesForTests,
} from '../../src/eve-map/active-route.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';
import type { WebAgentRequestCoordinator } from '../../src/web/agent-requests.js';
import { buildMapGraph, invalidateMapGraphCache } from '../../src/eve/map-graph.js';

/**
 * До этого эндпоинта единственным способом убрать линию с карты было попросить
 * заведомо невозможный маршрут — неудавшийся план публикует пустой. Маршрут,
 * проложенный лоцманом, вообще нельзя было снять с экрана.
 */

const ORIGIN = 'http://localhost:3000';

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

const coordinatorStub = {
  enqueue: () => { throw new Error('not used in this test'); },
} as unknown as WebAgentRequestCoordinator;

beforeEach(async () => {
  resetActiveRoutesForTests();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  seedChain(db);
  registerMapRoutes(app, db, coordinatorStub);
});

afterEach(async () => {
  await app.close();
  db.close();
  resetActiveRoutesForTests();
  invalidateMapGraphCache();
});

function browserSession() {
  const created = createWebSession(db);
  return { cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`, csrf: created.csrfToken };
}

function laneOf(): number {
  const row = db.prepare('SELECT chat_id FROM web_sessions ORDER BY rowid DESC LIMIT 1')
    .get() as { chat_id: number };
  return row.chat_id;
}

/** Alpha — Beta: достаточно, чтобы построить настоящий маршрут через HTTP. */
function seedChain(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  database.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('1', 'now');
  database.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (1, ?, ?)').run('R', '{}');
  database.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (1, ?, 1, ?)').run('C', '{}');
  const system = database.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
  system.run(30000001, 'Alpha', JSON.stringify({ securityStatus: 0.9, position2D: { x: 0, y: 0 } }));
  system.run(30000002, 'Beta', JSON.stringify({ securityStatus: 0.5, position2D: { x: 10, y: 0 } }));
  const gate = database.prepare('INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, NULL, ?)');
  gate.run(1, 30000001, 30000002, '{}');
  gate.run(2, 30000002, 30000001, '{}');
  buildMapGraph(database, { force: true });
}

describe('DELETE /api/web/map/route', () => {
  it('takes an agent-planned route off the map', async () => {
    const session = browserSession();
    const chatId = laneOf();
    rememberRoute(chatId, { systemIds: [1, 2, 3], mode: 'secure', riskWeight: 0 });
    expect(getActiveRoute(chatId)).not.toBeNull();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/web/map/route',
      headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrf },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cleared: true });
    expect(getActiveRoute(chatId)).toBeNull();
  });

  it('refuses without a CSRF token and leaves the route drawn', async () => {
    const session = browserSession();
    const chatId = laneOf();
    rememberRoute(chatId, { systemIds: [1, 2, 3], mode: 'secure', riskWeight: 0 });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/web/map/route',
      headers: { origin: ORIGIN, cookie: session.cookie },
    });

    expect(response.statusCode).toBe(403);
    // Чужой запрос не должен стирать линию, по которой пилот летит.
    expect(getActiveRoute(chatId)?.systemIds).toEqual([1, 2, 3]);
  });
});

describe('POST /api/web/map/route keeps a good line when it cannot plan a new one', () => {
  it('does not wipe the drawn route when the destination is unroutable', async () => {
    const session = browserSession();
    const chatId = laneOf();
    rememberRoute(chatId, { systemIds: [30000001, 30000002], mode: 'secure', riskWeight: 0 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/map/route',
      headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { origin: 30000001, destination: 39999999, mode: 'shortest', risk: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().route.ok).toBe(false);
    // Раньше неудавшийся план публиковал пустой маршрут и стирал линию, по
    // которой пилот в этот момент летел. Чистка теперь — отдельное действие.
    expect(getActiveRoute(chatId)?.systemIds).toEqual([30000001, 30000002]);
  });
});
