import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    userProfile: {
      path: '/tmp/eve-agent-auth-routes-tests/USER_{chat_id}_{character_id}.md',
      refreshSeconds: 300,
    },
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
import { createAuthRequestToken, recordAuthRequestConsent } from '../../src/auth/auth-request.js';
import { EVE_CONSENT_VERSION } from '../../src/web/eve-consent.js';
import { getAccessToken } from '../../src/eve/sso.js';
import { resetEveSsoMetadataCacheForTests } from '../../src/eve/sso-auth.js';
import {
  resolveUserProfilePath,
  withUserProfileAuthorizationLock,
} from '../../src/eve/user-profile-storage.js';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;
const PROFILE_TEST_DIR = '/tmp/eve-agent-auth-routes-tests';

beforeEach(() => {
  rmSync(PROFILE_TEST_DIR, { recursive: true, force: true });
  mkdirSync(PROFILE_TEST_DIR, { recursive: true });
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
  rmSync(PROFILE_TEST_DIR, { recursive: true, force: true });
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

  it('requires localized consent and redirects with only the selected EVE scopes', async () => {
    const { createEveLoginLink } = await import('../../src/eve/eve-login.js');
    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (1, 'pilot', datetime('now'), datetime('now'))").run();

    const link = createEveLoginLink(db, 1, 555);
    // Must be short enough for a Discord message/button (real SSO URL is ~2.1KB).
    expect(link.length).toBeLessThan(200);
    expect(link).toContain('/auth/eve/login?state=');
    const state = new URL(link).searchParams.get('state') as string;

    const app = Fastify();
    registerAuthRoutes(app, db);

    const consentPage = await app.inject({ method: 'GET', url: `/auth/eve/login?state=${encodeURIComponent(state)}` });
    expect(consentPage.statusCode).toBe(200);
    expect(consentPage.body).toContain('Вы решаете, что видит агент.');
    expect(consentPage.body).not.toContain('You decide what the agent can see.');
    const englishPage = await app.inject({ method: 'GET', url: `/auth/eve/login?state=${encodeURIComponent(state)}&language=en` });
    expect(englishPage.body).toContain('You decide what the agent can see.');
    expect(englishPage.body).not.toContain('Вы решаете, что видит агент.');

    const missingAcknowledgement = await app.inject({
      method: 'POST',
      url: '/auth/eve/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `state=${encodeURIComponent(state)}&language=ru&access=navigation`,
    });
    expect(missingAcknowledgement.statusCode).toBe(400);

    const invalidGroup = await app.inject({
      method: 'POST',
      url: '/auth/eve/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `state=${encodeURIComponent(state)}&language=ru&accepted=yes&access=admin`,
    });
    expect(invalidGroup.statusCode).toBe(400);

    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/eve/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `state=${encodeURIComponent(state)}&language=en&accepted=yes&access=navigation&access=economy`,
    });
    expect(accepted.statusCode).toBe(302);

    const overwriteAttempt = await app.inject({
      method: 'POST',
      url: '/auth/eve/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `state=${encodeURIComponent(state)}&language=ru&accepted=yes`,
    });
    expect(overwriteAttempt.statusCode).toBe(403);

    const redirect = await app.inject({ method: 'GET', url: `/auth/eve/login?state=${encodeURIComponent(state)}` });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toContain('https://login.eveonline.com/v2/oauth/authorize');
    const authorizeUrl = new URL(redirect.headers.location as string);
    const requestedScopes = authorizeUrl.searchParams.get('scope')?.split(' ') ?? [];
    expect(requestedScopes).toContain('esi-location.read_location.v1');
    expect(requestedScopes).toContain('esi-wallet.read_character_wallet.v1');
    expect(requestedScopes).not.toContain('esi-mail.read_mail.v1');
    expect(requestedScopes).not.toContain('esi-mail.send_mail.v1');

    const identityLink = createEveLoginLink(db, 1, 555);
    const identityState = new URL(identityLink).searchParams.get('state') as string;
    const identityConsent = await app.inject({
      method: 'POST',
      url: '/auth/eve/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `state=${encodeURIComponent(identityState)}&language=ru&accepted=yes`,
    });
    expect(identityConsent.statusCode).toBe(302);
    const identityRedirect = await app.inject({ method: 'GET', url: `/auth/eve/login?state=${encodeURIComponent(identityState)}` });
    expect(new URL(identityRedirect.headers.location as string).searchParams.has('scope')).toBe(false);

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

  it('rejects a token containing a scope outside the acknowledged set', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'pilot')").run();
    const state = createAuthRequestToken(db, 'eve_sso', 1, { ttlSeconds: 600 });
    consentRequest(state, ['esi-location.read_location.v1']);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'unexpected-scope-token',
        refresh_token: 'refresh-secret',
        expires_in: 1200,
        token_type: 'Bearer',
      }),
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'CHARACTER:EVE:95465498',
        name: 'Scope Pilot',
        scp: ['esi-mail.send_mail.v1'],
        aud: ['test-client', 'EVE Online'],
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain('unexpected scope');
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = 95465498').get()).toBeUndefined();
    await app.close();
  });

  it('removes stale private profiles from every lane before reduced scopes become active', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    const characterId = 95465502;
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'pilot')").run();
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (100, 'one'), (101, 'two')").run();
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (?, 'Scope Reduced', 'enc:old-a', 'enc:old-r', datetime('now', '+1 hour'), ?, 1)
    `).run(characterId, JSON.stringify([
      'esi-location.read_location.v1',
      'esi-wallet.read_character_wallet.v1',
    ]));
    db.prepare(`
      INSERT INTO eve_character_links (chat_id, character_id, user_id)
      VALUES (100, ?, 1), (101, ?, 1)
    `).run(characterId, characterId);

    const staleProfilePaths = [
      resolveUserProfilePath({ userId: 1, chatId: 100 }, characterId),
      resolveUserProfilePath({ userId: 1, chatId: 101 }, characterId),
      resolveUserProfilePath({ userId: 1 }, characterId),
    ];
    const state = createAuthRequestToken(db, 'eve_sso', 1, { chatId: 100, ttlSeconds: 600 });
    consentRequest(state, []);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'identity-only-access',
        refresh_token: 'identity-only-refresh',
        expires_in: 1200,
        token_type: 'Bearer',
      }),
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: `CHARACTER:EVE:${characterId}`,
        name: 'Scope Reduced',
        scp: [],
        aud: ['test-client', 'EVE Online'],
      },
    });

    let releaseOldRefresh = (): void => {};
    let markOldRefreshEntered = (): void => {};
    const oldRefreshEntered = new Promise<void>((resolve) => {
      markOldRefreshEntered = resolve;
    });
    const oldRefreshRelease = new Promise<void>((resolve) => {
      releaseOldRefresh = resolve;
    });
    const oldRefresh = withUserProfileAuthorizationLock(characterId, async () => {
      markOldRefreshEntered();
      await oldRefreshRelease;
      for (const path of staleProfilePaths) writeFileSync(path, 'old private wallet and location data');
    });
    await oldRefreshEntered;

    const responsePromise = app.inject({
      method: 'GET',
      url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    releaseOldRefresh();
    await oldRefresh;
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(refreshUserProfileMock).toHaveBeenCalledOnce();
    for (const path of staleProfilePaths) expect(existsSync(path)).toBe(false);
    expect(db.prepare('SELECT scopes_json FROM eve_accounts WHERE character_id = ?').get(characterId))
      .toEqual({ scopes_json: '[]' });
    await app.close();
  });

  it('GET /auth/eve/callback encrypts stored tokens and escapes character name', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
      .run(1, 'pilot');
    const state = createAuthRequestToken(db, 'eve_sso', 1, { ttlSeconds: 600 });
    consentRequest(state, ['esi-wallet.read_character_wallet.v1']);

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

    const row = db.prepare(`
      SELECT access_token, refresh_token, consent_version, consent_language, consented_at
      FROM eve_accounts WHERE character_id = ?
    `).get(95465499) as {
      access_token: string;
      refresh_token: string;
      consent_version: string;
      consent_language: string;
      consented_at: string;
    };
    expect(row.access_token).not.toBe('access-secret');
    expect(row.refresh_token).not.toBe('refresh-secret');
    expect(row.access_token.startsWith('enc:v1:')).toBe(true);
    expect(row.refresh_token.startsWith('enc:v1:')).toBe(true);
    expect(row.consent_version).toBe(EVE_CONSENT_VERSION);
    expect(row.consent_language).toBe('ru');
    expect(row.consented_at).toBeTruthy();

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
    consentRequest(state, ['esi-location.read_location.v1']);

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
    consentRequest(state, ['esi-location.read_location.v1']);

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
    expect(response.headers.location).toBe('http://localhost:3000/app?auth=connected');
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

  it('does not delete the current owner profile when browser ownership validation fails', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);
    const characterId = 95465503;
    const browserChatId = -2_000_000_000;
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'Owner'), (2, 'Browser')").run();
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (111, 'owner'), (?, 'web')")
      .run(browserChatId);
    db.prepare(`
      INSERT INTO web_sessions (
        session_hash, csrf_hash, user_id, chat_id, created_at, last_seen_at, expires_at
      ) VALUES ('h1:session', 'h1:csrf', 2, ?, datetime('now'), datetime('now'), datetime('now', '+1 hour'))
    `).run(browserChatId);
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (?, 'Owner Pilot', 'enc:owner-a', 'enc:owner-r', datetime('now', '+1 hour'), ?, 1)
    `).run(characterId, JSON.stringify(['esi-wallet.read_character_wallet.v1']));
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (111, ?, 1)')
      .run(characterId);

    const ownerPaths = [
      resolveUserProfilePath({ userId: 1, chatId: 111 }, characterId),
      resolveUserProfilePath({ userId: 1 }, characterId),
    ];
    for (const path of ownerPaths) writeFileSync(path, 'current owner private profile');

    const state = createAuthRequestToken(db, 'eve_sso', 2, {
      chatId: browserChatId,
      redirectUrl: '/app',
      ttlSeconds: 600,
    });
    consentRequest(state, []);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'browser-access',
        refresh_token: 'browser-refresh',
        expires_in: 1200,
        token_type: 'Bearer',
      }),
    });
    let markJwtVerified = (): void => {};
    let releaseProfileLock = (): void => {};
    let markProfileLockEntered = (): void => {};
    const jwtVerified = new Promise<void>((resolve) => {
      markJwtVerified = resolve;
    });
    const profileLockEntered = new Promise<void>((resolve) => {
      markProfileLockEntered = resolve;
    });
    const profileLockRelease = new Promise<void>((resolve) => {
      releaseProfileLock = resolve;
    });
    jwtVerifyMock.mockImplementationOnce(async () => {
      markJwtVerified();
      return {
        payload: {
          sub: `CHARACTER:EVE:${characterId}`,
          name: 'Owner Pilot',
          scp: [],
          aud: ['test-client', 'EVE Online'],
        },
      };
    });

    const blocker = withUserProfileAuthorizationLock(characterId, async () => {
      markProfileLockEntered();
      await profileLockRelease;
    });
    await profileLockEntered;
    const responsePromise = app.inject({
      method: 'GET',
      url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    await jwtVerified;
    await new Promise<void>((resolve) => setImmediate(resolve));
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (95465504, 'Browser Pilot', 'enc:web-a', 'enc:web-r', datetime('now', '+1 hour'), '[]', 2)
    `).run();
    releaseProfileLock();
    await blocker;
    const response = await responsePromise;

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('http://localhost:3000/app?auth=error');
    for (const path of ownerPaths) expect(existsSync(path)).toBe(true);
    expect(db.prepare('SELECT scopes_json, user_id FROM eve_accounts WHERE character_id = ?').get(characterId))
      .toEqual({ scopes_json: '["esi-wallet.read_character_wallet.v1"]', user_id: 1 });
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = 2').get()).toBeDefined();
    await app.close();
  });

  it('GET /auth/eve/callback does not leak internal error details', async () => {
    const app = Fastify();
    registerAuthRoutes(app, db);

    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
      .run(1, 'pilot');
    const state = createAuthRequestToken(db, 'eve_sso', 1, { ttlSeconds: 600 });
    consentRequest(state, []);

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

function consentRequest(state: string, scopes: string[]): void {
  expect(recordAuthRequestConsent(db, 'eve_sso', state, {
    version: EVE_CONSENT_VERSION,
    language: 'ru',
    scopes,
  })).toBe(true);
}
