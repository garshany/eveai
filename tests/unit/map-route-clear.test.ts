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
  registerMapRoutes(app, db, coordinatorStub);
});

afterEach(async () => {
  await app.close();
  db.close();
  resetActiveRoutesForTests();
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
