import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
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
import { createWebSession } from '../../src/auth/session.js';
import { buildSecurityHeaders, registerSecurityHeaders } from '../../src/web/security.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('web frontend hardening', () => {
  it('serves landing page without inline handlers and with strict script CSP', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, { baseUrl: 'http://localhost:3000' });
    registerFrontendRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self' https://telegram.org");
    expect(res.headers['content-security-policy']).not.toContain("'unsafe-inline'");
    expect(res.headers['content-security-policy']).not.toContain("'unsafe-eval'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.body).toContain('<link rel="stylesheet" href="/client/assets/');
    expect(res.body).not.toContain('<style>');
    expect(res.body).not.toContain('onclick=');
    expect(res.body).not.toContain('onerror=');
    expect(res.body).toContain('data-auth-url="http://localhost:3000/auth/telegram/callback?nonce=');

    await app.close();
  });

  it('serves dashboard markup and script without innerHTML-based rendering', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, { baseUrl: 'http://localhost:3000' });
    registerFrontendRoutes(app, db);

    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(1, 'Test User');
    const sessionId = createWebSession(db, 1);

    const dashboardRes = await app.inject({
      method: 'GET',
      url: '/app',
      headers: { cookie: `eve_session=${sessionId}` },
    });
    expect(dashboardRes.statusCode).toBe(200);
    expect(dashboardRes.body).toContain('<script type="module" src="/client/assets/');
    expect(dashboardRes.body).not.toContain('onclick=');

    const scriptMatch = dashboardRes.body.match(/<script type="module" src="([^"]+)" defer><\/script>/);
    expect(scriptMatch?.[1]).toBeTruthy();
    const scriptRes = await app.inject({ method: 'GET', url: scriptMatch![1] });
    const appSource = readFileSync(new URL('../../client/src/app.tsx', import.meta.url), 'utf8');

    expect(scriptRes.statusCode).toBe(200);
    expect(appSource).not.toContain('innerHTML');
    expect(appSource).not.toContain('dangerouslySetInnerHTML');

    await app.close();
  });

  it('emits hsts only for secure deployments', () => {
    const secureHeaders = buildSecurityHeaders({ baseUrl: 'https://eve.example.com' });
    const insecureHeaders = buildSecurityHeaders({ baseUrl: 'http://localhost:3000' });

    expect(secureHeaders['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(insecureHeaders['Strict-Transport-Security']).toBeUndefined();
  });
});
