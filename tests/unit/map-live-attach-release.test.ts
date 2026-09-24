import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

const mocks = vi.hoisted(() => ({
  getLinkedCharacter: vi.fn(),
  attachLiveSession: vi.fn(),
  getShared: vi.fn(),
  releaseShared: vi.fn(),
}));

vi.mock('../../src/eve/sso.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve/sso.js')>();
  return { ...actual, getLinkedCharacter: mocks.getLinkedCharacter };
});
vi.mock('../../src/eve-map/live-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve-map/live-session.js')>();
  return { ...actual, attachLiveSession: mocks.attachLiveSession };
});
vi.mock('../../src/eve-map/advisor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve-map/advisor.js')>();
  mocks.getShared.mockImplementation(actual.getSharedAdvisorState);
  mocks.releaseShared.mockImplementation(actual.releaseSharedAdvisorState);
  return {
    ...actual,
    getSharedAdvisorState: mocks.getShared,
    releaseSharedAdvisorState: mocks.releaseShared,
  };
});

import { registerMapRoutes } from '../../src/web/map-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';
import type { WebAgentRequestCoordinator } from '../../src/web/agent-requests.js';

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  mocks.getLinkedCharacter.mockReset();
  mocks.attachLiveSession.mockReset();
  mocks.getShared.mockClear();
  mocks.releaseShared.mockClear();
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerMapRoutes(app, db, {} as unknown as WebAgentRequestCoordinator);
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe('GET /api/web/map/live refused attach', () => {
  it('releases the shared advisor reference when the live session is refused', async () => {
    const created = createWebSession(db);
    mocks.getLinkedCharacter.mockReturnValue({
      characterId: 9001,
      characterName: 'Pilot',
      scopes: ['esi-location.read_location.v1'],
    });
    mocks.attachLiveSession.mockReturnValue({
      ok: false,
      statusCode: 503,
      error: 'The live map is at capacity right now. Try again shortly.',
      retryAfterSeconds: 60,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/map/live',
      headers: { cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('60');
    expect(mocks.getShared).toHaveBeenCalledTimes(1);
    expect(mocks.releaseShared).toHaveBeenCalledTimes(1);
    expect(mocks.releaseShared).toHaveBeenCalledWith(9001);
  });
});
