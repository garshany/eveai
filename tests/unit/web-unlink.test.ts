import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

const { jwtVerifyMock, createRemoteJwkSetMock, refreshUserProfileMock, runAgentTurnMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  createRemoteJwkSetMock: vi.fn(() => ({})),
  refreshUserProfileMock: vi.fn(async () => ({ ok: false, error: 'skipped in test' })),
  runAgentTurnMock: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: createRemoteJwkSetMock,
  jwtVerify: jwtVerifyMock,
}));

vi.mock('../../src/eve/user-profile.js', () => ({
  refreshUserProfile: refreshUserProfileMock,
}));

vi.mock('../../src/chat/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chat/shared.js')>();
  return { ...actual, runAgentTurn: runAgentTurnMock };
});

import { registerAuthRoutes } from '../../src/web/auth-routes.js';
import { registerWebChatRoutes } from '../../src/web/chat-routes.js';
import { recordAuthRequestConsent } from '../../src/auth/auth-request.js';
import { EVE_CONSENT_VERSION } from '../../src/web/eve-consent.js';
import { resetEveSsoMetadataCacheForTests } from '../../src/eve/sso-auth.js';
import { resetChatRequestGuardForTests } from '../../src/chat/shared.js';
import { resetWebSessionCreationGuardForTests } from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';
const MAIN_ID = 9_500_111;
const MAIN_NAME = 'Main';
const ALT_ID = 9_500_222;
const ALT_NAME = 'Alt';
const LINK_SCOPES = ['esi-location.read_location.v1'];

type BrowserSession = {
  cookie: string;
  csrf: string;
  userId: number;
  chatId: number;
};

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetChatRequestGuardForTests();
  resetWebSessionCreationGuardForTests();
  resetEveSsoMetadataCacheForTests();
  jwtVerifyMock.mockReset();
  createRemoteJwkSetMock.mockClear();
  refreshUserProfileMock.mockClear();
  runAgentTurnMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerAuthRoutes(app, db);
  registerWebChatRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
  vi.unstubAllGlobals();
});

async function createBrowserSession(): Promise<BrowserSession> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/web/session',
    headers: { origin: ORIGIN },
  });
  expect(response.statusCode).toBe(200);
  const payload = response.json() as { session: { csrfToken: string } };
  const setCookie = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie']
    : [response.headers['set-cookie'] as string];
  const cookie = setCookie.map((value) => value.split(';', 1)[0]).join('; ');
  const sessionRow = db.prepare(`
    SELECT user_id, chat_id FROM web_sessions ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get() as { user_id: number; chat_id: number };
  return {
    cookie,
    csrf: payload.session.csrfToken,
    userId: sessionRow.user_id,
    chatId: sessionRow.chat_id,
  };
}

function mutationHeaders(session: BrowserSession) {
  return {
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
}

async function linkCharacterViaSso(
  session: BrowserSession,
  characterId: number,
  characterName: string,
): Promise<void> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/web/eve/login',
    headers: mutationHeaders(session),
    payload: {},
  });
  expect(login.statusCode).toBe(200);
  const { url } = login.json() as { url: string };
  const state = new URL(url).searchParams.get('state') as string;
  expect(state).toBeTruthy();
  expect(recordAuthRequestConsent(db, 'eve_sso', state, {
    version: EVE_CONSENT_VERSION,
    language: 'ru',
    scopes: LINK_SCOPES,
  })).toBe(true);

  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      access_token: `access-${characterId}`,
      refresh_token: `refresh-${characterId}`,
      expires_in: 1200,
      token_type: 'Bearer',
    }),
  });
  jwtVerifyMock.mockResolvedValue({
    payload: {
      sub: `CHARACTER:EVE:${characterId}`,
      name: characterName,
      scp: LINK_SCOPES,
      aud: ['test-eve-client-id', 'EVE Online'],
    },
  });

  const callback = await app.inject({
    method: 'GET',
    url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
  });
  expect(callback.statusCode).toBe(302);
  expect(callback.headers.location).toBe('http://localhost:3000/app?auth=connected');
}

describe('browser character unlink', () => {
  it('revokes access and drops tokens, links and character data', async () => {
    const session = await createBrowserSession();
    await linkCharacterViaSso(session, MAIN_ID, MAIN_NAME);
    // Materialized private rows of the character must not survive the unlink.
    db.prepare(`
      INSERT INTO character_profile (character_id, character_name, synced_at)
      VALUES (?, ?, datetime('now'))
    `).run(MAIN_ID, MAIN_NAME);

    const unlinked = await app.inject({
      method: 'POST',
      url: `/api/web/characters/${MAIN_ID}/unlink`,
      headers: mutationHeaders(session),
    });
    expect(unlinked.statusCode).toBe(204);

    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(MAIN_ID)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM eve_character_links WHERE character_id = ?').get(MAIN_ID)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM character_profile WHERE character_id = ?').get(MAIN_ID)).toBeUndefined();
    expect(db.prepare('SELECT active_character_id FROM users WHERE user_id = ?').get(session.userId))
      .toEqual({ active_character_id: null });

    const characters = await app.inject({
      method: 'GET',
      url: '/api/web/characters',
      headers: { cookie: session.cookie },
    });
    expect((characters.json() as { characters: unknown[] }).characters).toEqual([]);
  });

  it('keeps the second character and its account when unlinking one of two', async () => {
    const session = await createBrowserSession();
    await linkCharacterViaSso(session, MAIN_ID, MAIN_NAME);
    await linkCharacterViaSso(session, ALT_ID, ALT_NAME);

    const unlinked = await app.inject({
      method: 'POST',
      url: `/api/web/characters/${MAIN_ID}/unlink`,
      headers: mutationHeaders(session),
    });
    expect(unlinked.statusCode).toBe(204);

    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(MAIN_ID)).toBeUndefined();
    expect(db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = ?').get(ALT_ID))
      .toEqual({ user_id: session.userId });
    expect(db.prepare('SELECT 1 FROM eve_character_links WHERE character_id = ? AND user_id = ?')
      .get(ALT_ID, session.userId)).toBeDefined();

    const characters = await app.inject({
      method: 'GET',
      url: '/api/web/characters',
      headers: { cookie: session.cookie },
    });
    expect((characters.json() as { characters: Array<{ characterId: number; isActive: boolean }> }).characters)
      .toEqual([{ characterId: ALT_ID, characterName: ALT_NAME, isActive: true }]);
  });

  it('rejects unlinking a character that is not linked to this user', async () => {
    const owner = await createBrowserSession();
    await linkCharacterViaSso(owner, MAIN_ID, MAIN_NAME);
    const intruder = await createBrowserSession();

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/web/characters/${MAIN_ID}/unlink`,
      headers: mutationHeaders(intruder),
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: 'Персонаж не найден.' });

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/web/characters/${ALT_ID}/unlink`,
      headers: mutationHeaders(intruder),
    });
    expect(unknown.statusCode).toBe(404);

    // The owner's link and tokens are untouched by the failed attempts.
    expect(db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = ?').get(MAIN_ID))
      .toEqual({ user_id: owner.userId });
    expect(db.prepare('SELECT 1 FROM eve_character_links WHERE character_id = ?').get(MAIN_ID)).toBeDefined();
  });

  it('requires the CSRF mutation checks', async () => {
    const session = await createBrowserSession();
    await linkCharacterViaSso(session, MAIN_ID, MAIN_NAME);

    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/web/characters/${MAIN_ID}/unlink`,
      headers: { origin: ORIGIN, cookie: session.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(MAIN_ID)).toBeDefined();
  });
});
