import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

const { jwtVerifyMock, createRemoteJwkSetMock, refreshUserProfileMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  createRemoteJwkSetMock: vi.fn(() => ({})),
  refreshUserProfileMock: vi.fn(async () => ({ ok: false, error: 'skipped in test' })),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback',
      requestTimeoutMs: 5000,
    },
    esi: {
      userAgent: 'EVEAI/3.3 (+https://github.com/example/eveai; contact=operator@example.com)',
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'http://localhost:3000' },
  },
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: createRemoteJwkSetMock,
  jwtVerify: jwtVerifyMock,
}));

vi.mock('../../src/eve/user-profile.js', () => ({
  refreshUserProfile: refreshUserProfileMock,
}));

import Fastify from 'fastify';
import { registerAuthRoutes } from '../../src/web/auth-routes.js';
import { registerHealthRoute } from '../../src/web/health.js';
import { createAuthRequestToken } from '../../src/auth/auth-request.js';
import { getAccessToken } from '../../src/eve/sso.js';
import { resetEveSsoMetadataCacheForTests } from '../../src/eve/sso-auth.js';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  jwtVerifyMock.mockReset();
  createRemoteJwkSetMock.mockClear();
  refreshUserProfileMock.mockClear();
  resetEveSsoMetadataCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('issues a short /eve_login link that /auth/eve/login redirects to EVE SSO', async () => {
    const { createEveLoginLink } = await import('../../src/eve/eve-login.js');
    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (1, 'pilot', datetime('now'), datetime('now'))").run();

    const link = createEveLoginLink(db, 1, 555);
    // Must be short enough for a Discord message/button (real SSO URL is ~2.1KB).
    expect(link.length).toBeLessThan(200);
    expect(link).toContain('/auth/eve/login?state=');
    const state = new URL(link).searchParams.get('state') as string;

    const app = Fastify();
    registerAuthRoutes(app, db);

    const redirect = await app.inject({ method: 'GET', url: `/auth/eve/login?state=${encodeURIComponent(state)}` });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toContain('https://login.eveonline.com/v2/oauth/authorize');
    expect((redirect.headers.location as string).length).toBeGreaterThan(1500); // full scopes on the redirect, not the chat message

    const bogus = await app.inject({ method: 'GET', url: '/auth/eve/login?state=nope' });
    expect(bogus.statusCode).toBe(403);
    const missing = await app.inject({ method: 'GET', url: '/auth/eve/login' });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });

  it('GET /auth/eve/callback rejects invalid state', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    const res = await app.inject({ method: 'GET', url: '/auth/eve/callback?code=abc&state=bogus' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('Invalid or expired state parameter');
    await app.close();
  });

  it('GET /auth/eve/callback rejects legacy telegram_sessions oauth_state fallback', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, oauth_state) VALUES (0, 'web', 'state-0')").run();

    const res = await app.inject({ method: 'GET', url: '/auth/eve/callback?code=abc&state=state-0' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('Invalid or expired state parameter');
    await app.close();
  });

  it('GET /auth/eve/callback encrypts stored tokens and escapes character name', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
      .run(1, 'pilot');
    const state = createAuthRequestToken(db, 'eve_sso', 1, { ttlSeconds: 600 });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 1200,
        token_type: 'Bearer',
      }),
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'CHARACTER:EVE:95465499',
        name: '<img src=x onerror=alert(1)>',
        scp: ['esi-wallet.read_character_wallet.v1'],
        aud: ['test-client', 'EVE Online'],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.body).not.toContain('<img src=x onerror=alert(1)>');

    const row = db.prepare('SELECT access_token, refresh_token FROM eve_accounts WHERE character_id = ?')
      .get(95465499) as { access_token: string; refresh_token: string };
    expect(row.access_token).not.toBe('access-secret');
    expect(row.refresh_token).not.toBe('refresh-secret');
    expect(row.access_token.startsWith('enc:v1:')).toBe(true);
    expect(row.refresh_token.startsWith('enc:v1:')).toBe(true);

    const access = await getAccessToken(db, { userId: 1 });
    expect(access).toEqual({ token: 'access-secret', characterId: 95465499 });
    expect(fetchMock.mock.calls.some((call) => call[0] === 'https://login.eveonline.com/.well-known/oauth-authorization-server')).toBe(true);
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'access-secret',
      expect.anything(),
      expect.objectContaining({
        issuer: expect.arrayContaining(['https://login.eveonline.com/']),
      }),
    );

    await app.close();
  });

  it('keeps chat_id zero when an EVE callback links the CLI lane', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'CLI')").run();
    db.prepare("INSERT INTO cli_accounts (identity_key, user_id, chat_id) VALUES ('local', 1, 0)").run();
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (0, 'cli')").run();
    const state = createAuthRequestToken(db, 'eve_sso', 1, { chatId: 0, ttlSeconds: 600 });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'cli-access',
        refresh_token: 'cli-refresh',
        expires_in: 1200,
        token_type: 'Bearer',
      }),
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'CHARACTER:EVE:95465500',
        name: 'Cli Pilot',
        scp: ['esi-location.read_location.v1'],
        aud: ['test-client', 'EVE Online'],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT user_id FROM eve_character_links WHERE chat_id = 0 AND character_id = 95465500').get())
      .toEqual({ user_id: 1 });
    expect(db.prepare('SELECT active_character_id FROM telegram_sessions WHERE chat_id = 0').get())
      .toEqual({ active_character_id: 95465500 });
    await app.close();
  });

  it('merges a browser SSO lane into the existing character owner without stealing other channel links', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'Telegram Pilot'), (2, 'Web capsuleer')").run();
    db.prepare(`
      INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name)
      VALUES (111, 1, 'telegram', 'Pilot')
    `).run();
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (111, 'telegram'), (-2000000000, 'web')").run();
    db.prepare(`
      INSERT INTO web_sessions (
        session_hash, csrf_hash, user_id, chat_id, created_at, last_seen_at, expires_at
      ) VALUES ('h1:web-session', 'h1:csrf', 2, -2000000000, datetime('now'), datetime('now'), datetime('now', '+1 hour'))
    `).run();
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (95465501, 'Shared Pilot', 'enc:old-a', 'enc:old-r', datetime('now', '+1 hour'), '[]', 1)
    `).run();
    db.prepare(`
      INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (111, 95465501, 1)
    `).run();
    const state = createAuthRequestToken(db, 'eve_sso', 2, {
      chatId: -2_000_000_000,
      redirectUrl: '/app',
      ttlSeconds: 600,
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'web-access',
        refresh_token: 'web-refresh',
        expires_in: 1200,
        token_type: 'Bearer',
      }),
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'CHARACTER:EVE:95465501',
        name: 'Shared Pilot',
        scp: ['esi-location.read_location.v1'],
        aud: ['test-client', 'EVE Online'],
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/app?auth=connected');
    expect(db.prepare('SELECT user_id FROM web_sessions WHERE chat_id = -2000000000').get())
      .toEqual({ user_id: 1 });
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = 2').get()).toBeUndefined();
    expect(db.prepare(`
      SELECT chat_id, user_id FROM eve_character_links WHERE character_id = 95465501 ORDER BY chat_id
    `).all()).toEqual([
      { chat_id: -2_000_000_000, user_id: 1 },
      { chat_id: 111, user_id: 1 },
    ]);
    expect(db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = 95465501').get())
      .toEqual({ user_id: 1 });
    await app.close();
  });

  it('GET /auth/eve/callback does not leak internal error details', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
      .run(1, 'pilot');
    const state = createAuthRequestToken(db, 'eve_sso', 1, { ttlSeconds: 600 });

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:443 internal-sso-gateway'));

    const res = await app.inject({
      method: 'GET',
      url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.body).not.toContain('internal-sso-gateway');

    await app.close();
  });

  it('GET /callback forwards query params to /auth/eve/callback', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/callback?code=abc&state=xyz' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/eve/callback?code=abc&state=xyz');

    await app.close();
  });
});
