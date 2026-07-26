import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

const ORIGIN = 'http://localhost:3000';

function siteverifyResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function freshChallenge() {
  return {
    success: true,
    hostname: 'localhost',
    action: 'session',
    challenge_ts: new Date().toISOString(),
  };
}

describe('web session creation behind Turnstile', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    process.env.TURNSTILE_SITE_KEY = 'site-test';
    process.env.TURNSTILE_SECRET_KEY = 'secret-test';
    process.env.TURNSTILE_EXPECTED_HOSTNAME = 'localhost';
    vi.resetModules();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    const { resetWebSessionCreationGuardForTests } = await import('../../src/web/web-session.js');
    resetWebSessionCreationGuardForTests();
    const { registerWebChatRoutes } = await import('../../src/web/chat-routes.js');
    app = Fastify({ bodyLimit: 64 * 1024 });
    await app.register(fastifyCookie);
    registerWebChatRoutes(app, db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_EXPECTED_HOSTNAME;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function postSession(payload?: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/web/session',
      headers: { origin: ORIGIN },
      payload: payload as Record<string, unknown>,
    });
  }

  it('issues a session for a server-verified token without logging or caching it', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(siteverifyResponse(freshChallenge())));
    vi.stubGlobal('fetch', fetchMock);

    const response = await postSession({ turnstileToken: 'valid-token-value' });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()).toEqual({ n: 1 });

    const reused = await app.inject({
      method: 'POST',
      url: '/api/web/session',
      headers: { origin: ORIGIN, cookie: '' },
      payload: { turnstileToken: 'valid-token-value' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reused.statusCode).toBe(200);
  });

  it('rejects a missing token without calling Siteverify', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await postSession({});
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()).toEqual({ n: 0 });
  });

  it('rejects a reused token reported as timeout-or-duplicate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(siteverifyResponse({
      success: false,
      'error-codes': ['timeout-or-duplicate'],
    })));

    const response = await postSession({ turnstileToken: 'reused-token-value' });
    expect(response.statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()).toEqual({ n: 0 });
  });

  it('fails closed with 503 and Retry-After while Siteverify is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('cloudflare down')));

    const response = await postSession({ turnstileToken: 'valid-token-value' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('3');
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()).toEqual({ n: 0 });
  });

  it('rejects a token minted for another hostname', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(siteverifyResponse({
      ...freshChallenge(),
      hostname: 'attacker.example',
    })));

    const response = await postSession({ turnstileToken: 'valid-token-value' });
    expect(response.statusCode).toBe(403);
  });
});
