import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import {
  cleanExpiredWebSessions,
  resetWebSessionCreationGuardForTests,
} from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';
const CHARACTER_ID = 9_500_001;
const CHARACTER_NAME = 'Returning Pilot';
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

async function linkCharacterViaSso(session: BrowserSession): Promise<void> {
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
      access_token: `access-${CHARACTER_ID}`,
      refresh_token: `refresh-${CHARACTER_ID}`,
      expires_in: 1200,
      token_type: 'Bearer',
    }),
  });
  jwtVerifyMock.mockResolvedValue({
    payload: {
      sub: `CHARACTER:EVE:${CHARACTER_ID}`,
      name: CHARACTER_NAME,
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

async function createConversationWithMessage(session: BrowserSession, text: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/web/conversations',
    headers: mutationHeaders(session),
  });
  expect(created.statusCode).toBe(201);
  const { threadId } = created.json() as { threadId: string };
  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)").run(threadId, text);
  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'assistant', 'Ответ')").run(threadId);
  return threadId;
}

function insertUsage(userId: number, threadId: string, events: number): void {
  db.prepare(`
    INSERT INTO usage_events (
      created_at_ms, user_id, thread_id, channel, model,
      input_tokens, output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, cost_micros
    ) VALUES (?, ?, ?, 'web', 'test-model', 10, 5, 0, 0, 0, 100)
  `).run(Date.now(), userId, threadId);
  db.prepare(`
    INSERT INTO usage_daily (
      day, channel, model, user_id, events,
      input_tokens, output_tokens, cached_tokens, cache_write_tokens,
      reasoning_tokens, cost_micros, unknown_cost_events
    ) VALUES ('2026-07-27', 'web', 'test-model', ?, ?, 10, 5, 0, 0, 0, 100, 0)
  `).run(userId, events);
}

describe('web relogin preserves user data', () => {
  it('keeps conversations, characters, market and usage data across logout and SSO relogin', async () => {
    const first = await createBrowserSession();
    await linkCharacterViaSso(first);
    const threadId = await createConversationWithMessage(first, 'Первый вопрос после линка');
    db.prepare('INSERT INTO market_watchlist (user_id, type_id, region_id) VALUES (?, 34, 10000002)')
      .run(first.userId);
    db.prepare(`
      INSERT INTO market_price_alerts (user_id, type_id, region_id, side, comparator, threshold_price)
      VALUES (?, 35, 10000002, 'sell', 'below', 123.45)
    `).run(first.userId);
    insertUsage(first.userId, threadId, 3);

    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/web/session',
      headers: mutationHeaders(first),
    });
    expect(logout.statusCode).toBe(204);

    // Logout must not destroy the persistent identity or any of its data.
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(first.userId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(CHARACTER_ID)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM agent_threads WHERE thread_id = ?').get(threadId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM market_watchlist WHERE user_id = ?').get(first.userId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM market_price_alerts WHERE user_id = ?').get(first.userId)).toBeDefined();

    const second = await createBrowserSession();
    expect(second.userId).not.toBe(first.userId);
    await linkCharacterViaSso(second);

    // Merge direction: the pre-existing owner survives, the fresh guest is folded in.
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(second.userId)).toBeUndefined();
    expect(db.prepare('SELECT user_id FROM web_sessions WHERE chat_id = ?').get(second.chatId))
      .toEqual({ user_id: first.userId });
    // The orphaned first lane was adopted into the active one.
    expect(db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(first.chatId)).toBeUndefined();
    expect(db.prepare('SELECT chat_id, user_id FROM agent_threads WHERE thread_id = ?').get(threadId))
      .toEqual({ chat_id: second.chatId, user_id: first.userId });

    const conversations = await app.inject({
      method: 'GET',
      url: '/api/web/conversations',
      headers: { cookie: second.cookie },
    });
    expect(conversations.statusCode).toBe(200);
    const list = (conversations.json() as { conversations: Array<{ id: string; title: string }> }).conversations;
    expect(list.map((entry) => entry.id)).toContain(threadId);
    expect(list.find((entry) => entry.id === threadId)?.title).toBe('Первый вопрос после линка');

    const messages = await app.inject({
      method: 'GET',
      url: `/api/web/conversations/${threadId}/messages`,
      headers: { cookie: second.cookie },
    });
    expect(messages.statusCode).toBe(200);
    expect((messages.json() as { messages: unknown[] }).messages).toHaveLength(2);

    const characters = await app.inject({
      method: 'GET',
      url: '/api/web/characters',
      headers: { cookie: second.cookie },
    });
    expect(characters.statusCode).toBe(200);
    expect((characters.json() as { characters: Array<{ characterId: number; characterName: string; isActive: boolean }> }).characters)
      .toEqual([{ characterId: CHARACTER_ID, characterName: CHARACTER_NAME, isActive: true }]);

    // User-scoped market and usage rows stayed with the surviving identity.
    expect(db.prepare('SELECT user_id FROM market_watchlist').all()).toEqual([{ user_id: first.userId }]);
    expect(db.prepare('SELECT user_id FROM market_price_alerts').all()).toEqual([{ user_id: first.userId }]);
    expect(db.prepare('SELECT user_id FROM usage_events').all()).toEqual([{ user_id: first.userId }]);
    expect(db.prepare('SELECT user_id, events FROM usage_daily').all())
      .toEqual([{ user_id: first.userId, events: 3 }]);
  });

  it('folds the fresh guest pre-link data into the existing owner instead of overwriting it', async () => {
    const first = await createBrowserSession();
    await linkCharacterViaSso(first);
    insertUsage(first.userId, '00000000-0000-0000-0000-0000000000aa', 3);
    db.prepare('INSERT INTO market_watchlist (user_id, type_id, region_id) VALUES (?, 34, 10000002)')
      .run(first.userId);
    await app.inject({ method: 'DELETE', url: '/api/web/session', headers: mutationHeaders(first) });

    const guest = await createBrowserSession();
    const guestThread = await createConversationWithMessage(guest, 'Гостевой вопрос до линка');
    insertUsage(guest.userId, guestThread, 2);
    db.prepare('INSERT INTO market_watchlist (user_id, type_id, region_id) VALUES (?, 36, 10000002)')
      .run(guest.userId);

    await linkCharacterViaSso(guest);

    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(guest.userId)).toBeUndefined();
    // Both watchlist entries end up on the surviving user.
    expect(db.prepare('SELECT type_id, user_id FROM market_watchlist ORDER BY type_id').all()).toEqual([
      { type_id: 34, user_id: first.userId },
      { type_id: 36, user_id: first.userId },
    ]);
    // Overlapping daily usage rows are summed, not clobbered.
    expect(db.prepare('SELECT user_id, events FROM usage_daily').all())
      .toEqual([{ user_id: first.userId, events: 5 }]);
    expect(db.prepare('SELECT user_id FROM usage_events ORDER BY created_at_ms').all()
      .every((row) => (row as { user_id: number }).user_id === first.userId)).toBe(true);
    // The guest lane conversation moved to the surviving user.
    expect(db.prepare('SELECT user_id FROM agent_threads WHERE thread_id = ?').get(guestThread))
      .toEqual({ user_id: first.userId });
  });

  it('keeps data when the session expires instead of an explicit logout', async () => {
    const first = await createBrowserSession();
    await linkCharacterViaSso(first);
    const threadId = await createConversationWithMessage(first, 'Вопрос до истечения сессии');
    db.prepare("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE chat_id = ?")
      .run(first.chatId);

    const expired = await app.inject({
      method: 'GET',
      url: '/api/web/session',
      headers: { cookie: first.cookie },
    });
    expect(expired.json()).toMatchObject({ session: null });
    await cleanExpiredWebSessions(db, { force: true });

    expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(first.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(first.userId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(first.chatId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM agent_threads WHERE thread_id = ?').get(threadId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(CHARACTER_ID)).toBeDefined();

    const second = await createBrowserSession();
    await linkCharacterViaSso(second);
    const conversations = await app.inject({
      method: 'GET',
      url: '/api/web/conversations',
      headers: { cookie: second.cookie },
    });
    const list = (conversations.json() as { conversations: Array<{ id: string }> }).conversations;
    expect(list.map((entry) => entry.id)).toContain(threadId);
  });

  it('still purges an anonymous guest lane when its session expires', async () => {
    const guest = await createBrowserSession();
    const threadId = await createConversationWithMessage(guest, 'Анонимный вопрос');
    db.prepare("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE chat_id = ?")
      .run(guest.chatId);

    await cleanExpiredWebSessions(db, { force: true });

    expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(guest.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(guest.userId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(guest.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM agent_threads WHERE thread_id = ?').get(threadId)).toBeUndefined();
  });

  it('handles a repeated SSO callback for the same character from another fresh guest', async () => {
    const first = await createBrowserSession();
    await linkCharacterViaSso(first);
    const threadId = await createConversationWithMessage(first, 'Вопрос первой сессии');
    await app.inject({ method: 'DELETE', url: '/api/web/session', headers: mutationHeaders(first) });

    // Two fresh guests link the same character one after another (the second
    // one is what a racing concurrent callback serializes into).
    const second = await createBrowserSession();
    await linkCharacterViaSso(second);
    const third = await createBrowserSession();
    await linkCharacterViaSso(third);

    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(second.userId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(third.userId)).toBeUndefined();
    expect(db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ user_id: first.userId });
    expect(db.prepare('SELECT user_id FROM web_sessions WHERE chat_id = ?').get(third.chatId))
      .toEqual({ user_id: first.userId });

    // The second session keeps its live lane; its view of the history is intact.
    const conversations = await app.inject({
      method: 'GET',
      url: '/api/web/conversations',
      headers: { cookie: second.cookie },
    });
    const list = (conversations.json() as { conversations: Array<{ id: string }> }).conversations;
    expect(list.map((entry) => entry.id)).toContain(threadId);
    // Exactly one link row per lane for the character, all owned by the survivor.
    expect(db.prepare(`
      SELECT user_id FROM eve_character_links WHERE character_id = ? ORDER BY chat_id
    `).all(CHARACTER_ID)).toEqual([
      { user_id: first.userId },
      { user_id: first.userId },
    ]);
  });

  it('fails the callback when the browser session expired mid-login', async () => {
    const session = await createBrowserSession();
    const login = await app.inject({
      method: 'POST',
      url: '/api/web/eve/login',
      headers: mutationHeaders(session),
      payload: {},
    });
    expect(login.statusCode).toBe(200);
    const { url } = login.json() as { url: string };
    const state = new URL(url).searchParams.get('state') as string;
    expect(recordAuthRequestConsent(db, 'eve_sso', state, {
      version: EVE_CONSENT_VERSION,
      language: 'ru',
      scopes: LINK_SCOPES,
    })).toBe(true);

    // The session dies between the login start and the EVE callback.
    db.prepare("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE chat_id = ?")
      .run(session.chatId);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: `access-${CHARACTER_ID}`,
        refresh_token: `refresh-${CHARACTER_ID}`,
        expires_in: 1200,
        token_type: 'Bearer',
      }),
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: `CHARACTER:EVE:${CHARACTER_ID}`,
        name: CHARACTER_NAME,
        scp: LINK_SCOPES,
        aud: ['test-eve-client-id', 'EVE Online'],
      },
    });

    const callback = await app.inject({
      method: 'GET',
      url: `/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('http://localhost:3000/app?auth=error');
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(CHARACTER_ID)).toBeUndefined();
  });

  it('keeps guest conversations visible and counted toward the limit after linking', async () => {
    const session = await createBrowserSession();
    // Direct inserts: the POST endpoint would reuse the single empty thread.
    for (let index = 0; index < 40; index += 1) {
      const threadId = randomUUID();
      db.prepare(`
        INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id)
        VALUES (?, ?, NULL, ?)
      `).run(threadId, session.chatId, session.userId);
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)")
        .run(threadId, `Гостевой вопрос ${index}`);
    }

    await linkCharacterViaSso(session);

    // Guest threads (no character) stay listed once a character is active.
    const conversations = await app.inject({
      method: 'GET',
      url: '/api/web/conversations',
      headers: { cookie: session.cookie },
    });
    expect(conversations.statusCode).toBe(200);
    const list = (conversations.json() as { conversations: Array<{ id: string }> }).conversations;
    expect(list).toHaveLength(40);

    // The same visible set feeds the creation cap.
    const capped = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    expect(capped.statusCode).toBe(409);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/web/conversations/${list[0]!.id}`,
      headers: mutationHeaders(session),
    });
    expect(removed.statusCode).toBe(204);

    const created = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    expect(created.statusCode).toBe(201);
  });
});
