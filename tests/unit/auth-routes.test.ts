import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, createHmac } from 'node:crypto';
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
      userAgent: 'EVEAIBOT/1.0 (garshany80@gmail.com; +https://github.com/garshany/eveai)',
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, handoffTtlSeconds: 300 },
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
import { createWebSession } from '../../src/auth/session.js';
import { createAuthRequestToken } from '../../src/auth/auth-request.js';
import { createTelegramLoginNonce } from '../../src/auth/telegram-login.js';
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
  it('GET /auth/telegram/callback rejects users outside allowlist', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    const nonce = createTelegramLoginNonce(db);
    const query = buildTelegramLoginQuery({
      id: 2,
      first_name: 'Blocked',
      username: 'blocked',
      nonce,
    });

    const res = await app.inject({ method: 'GET', url: `/auth/telegram/callback?${query}` });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('Access denied');

    await app.close();
  });

  it('GET /auth/telegram/callback consumes the login challenge once', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    const nonce = createTelegramLoginNonce(db);
    const query = buildTelegramLoginQuery({
      id: 1,
      first_name: 'Pilot',
      username: 'pilot',
      nonce,
    });

    const first = await app.inject({ method: 'GET', url: `/auth/telegram/callback?${query}` });
    expect(first.statusCode).toBe(302);
    expect(first.headers['set-cookie']).toContain('eve_session=');

    const replay = await app.inject({ method: 'GET', url: `/auth/telegram/callback?${query}` });
    expect(replay.statusCode).toBe(403);
    expect(JSON.parse(replay.body).error).toContain('challenge expired or already used');

    await app.close();
  });

  it('GET /auth/eve/start rejects unauthenticated requests', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/auth/eve/start' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toContain('Not authenticated');

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

  it('GET /auth/eve/start stores only a protected auth state at rest', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
      .run(1, 'pilot');
    const sessionId = createWebSession(db, 1);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/eve/start',
      headers: {
        cookie: `eve_session=${sessionId}`,
      },
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location;
    expect(location).toBeTruthy();
    const state = new URL(location ?? 'http://localhost').searchParams.get('state');
    expect(state).toBeTruthy();

    const row = db.prepare("SELECT state FROM auth_requests WHERE type = 'eve_sso'").get() as { state: string };
    expect(row.state).not.toBe(state);
    expect(row.state.startsWith('h1:')).toBe(true);

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

  it('POST /auth/tg-handoff/exchange creates a session without query bearer tokens', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
      .run(1, 'pilot');
    const token = createAuthRequestToken(db, 'tg_handoff', 1, { chatId: 99, ttlSeconds: 300 });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/tg-handoff/exchange',
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.headers['set-cookie']).toContain('eve_session=');

    const replay = await app.inject({
      method: 'POST',
      url: '/auth/tg-handoff/exchange',
      payload: { token },
    });
    expect(replay.statusCode).toBe(403);

    await app.close();
  });
});

function buildTelegramLoginQuery(input: {
  id: number;
  first_name: string;
  username: string;
  nonce: string;
}): string {
  const auth_date = Math.floor(Date.now() / 1000);
  const payload: Record<string, string> = {
    id: String(input.id),
    first_name: input.first_name,
    username: input.username,
    auth_date: String(auth_date),
  };

  const checkString = Object.entries(payload)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHash('sha256').update('test').digest();
  const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');

  return new URLSearchParams({
    ...payload,
    hash,
    nonce: input.nonce,
  }).toString();
}
