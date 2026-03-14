import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test-client', clientSecret: 'test-secret', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '0.0.0.0' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
  },
}));

import Fastify from 'fastify';
import { registerAuthRoutes } from '../../src/web/auth-routes.js';
import { registerHealthRoute } from '../../src/web/health.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('health route', () => {
  it('returns status ok', async () => {
    const app = Fastify();
    registerHealthRoute(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    await app.close();
  });
});

describe('auth routes', () => {
  it('GET /auth/eve/start redirects to EVE SSO', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    // Need a session row for the state to be stored
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (0, 'web')").run();

    const res = await app.inject({ method: 'GET', url: '/auth/eve/start' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('login.eveonline.com');
    expect(res.headers.location).toContain('response_type=code');
    expect(res.headers.location).toContain('client_id=test-client');

    // Verify state was stored
    const session = db.prepare('SELECT oauth_state FROM telegram_sessions WHERE chat_id = 0').get() as { oauth_state: string };
    expect(session.oauth_state).toBeTruthy();
    expect(session.oauth_state.length).toBeGreaterThan(10);

    await app.close();
  });

  it('GET /auth/eve/callback rejects missing code', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    const res = await app.inject({ method: 'GET', url: '/auth/eve/callback' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Missing authorization code');
    await app.close();
  });

  it('GET /auth/eve/callback rejects missing state', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    const res = await app.inject({ method: 'GET', url: '/auth/eve/callback?code=abc' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Missing state');
    await app.close();
  });

  it('GET /auth/eve/callback rejects invalid state', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    const res = await app.inject({ method: 'GET', url: '/auth/eve/callback?code=abc&state=bogus' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('Invalid or expired state');
    await app.close();
  });
});
