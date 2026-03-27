import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botUsername: 'eveagentbot' },
    eve: { clientSecret: 'eve-secret' },
    openai: { apiKey: 'openai-secret' },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

import { registerFrontendRoutes } from '../../src/web/frontend.js';
import { registerSecurityHeaders } from '../../src/web/security.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('frontend handoff page', () => {
  it('serves a dedicated handoff shell without embedding a query token', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, { baseUrl: 'http://localhost:3000' });
    registerFrontendRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/auth/tg-handoff' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('data-page="handoff"');
    expect(res.body).toContain('data-auth-url="http://localhost:3000/auth/tg-handoff/exchange"');
    expect(res.body).not.toContain('?token=');

    await app.close();
  });
});
