import { randomUUID } from 'node:crypto';
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

async function createConversationWithMessage(session: BrowserSession, text: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/web/conversations',
    headers: mutationHeaders(session),
  });
  expect(created.statusCode).toBe(201);
  const { threadId } = created.json() as { threadId: string };
  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)").run(threadId, text);
  return threadId;
}

function insertThread(userId: number, chatId: number): string {
  const threadId = randomUUID();
  db.prepare(`
    INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id)
    VALUES (?, ?, NULL, ?)
  `).run(threadId, chatId, userId);
  return threadId;
}

function insertAgentRequest(input: {
  requestId: string;
  userId: number;
  chatId: number;
  threadId: string;
  idempotencyKey: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
}): void {
  db.prepare(`
    INSERT INTO web_agent_requests (
      request_id, user_id, chat_id, thread_id, character_id, character_version,
      message, message_hash, idempotency_key, status, created_at_ms
    ) VALUES (?, ?, ?, ?, NULL, 0, 'msg', 'hash', ?, ?, ?)
  `).run(
    input.requestId,
    input.userId,
    input.chatId,
    input.threadId,
    input.idempotencyKey,
    input.status,
    Date.now(),
  );
}

describe('browser SSO with multiple characters', () => {
  it('merges a guest that already owns an alt into the main character owner', async () => {
    const first = await createBrowserSession();
    await linkCharacterViaSso(first, MAIN_ID, MAIN_NAME);
    const threadId = await createConversationWithMessage(first, 'Вопрос мейна до логаута');

    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/web/session',
      headers: mutationHeaders(first),
    });
    expect(logout.statusCode).toBe(204);

    // A fresh guest links an unowned alt first: the keep branch makes the
    // guest its owner.
    const guest = await createBrowserSession();
    await linkCharacterViaSso(guest, ALT_ID, ALT_NAME);
    expect(db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = ?').get(ALT_ID))
      .toEqual({ user_id: guest.userId });

    // Linking the main (owned by the first user) merges the guest, alt
    // included, into the pre-existing owner.
    await linkCharacterViaSso(guest, MAIN_ID, MAIN_NAME);

    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(guest.userId)).toBeUndefined();
    expect(db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = ?').get(MAIN_ID))
      .toEqual({ user_id: first.userId });
    expect(db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = ?').get(ALT_ID))
      .toEqual({ user_id: first.userId });

    const conversations = await app.inject({
      method: 'GET',
      url: '/api/web/conversations',
      headers: { cookie: guest.cookie },
    });
    expect(conversations.statusCode).toBe(200);
    const list = (conversations.json() as { conversations: Array<{ id: string }> }).conversations;
    expect(list.map((entry) => entry.id)).toContain(threadId);

    const characters = await app.inject({
      method: 'GET',
      url: '/api/web/characters',
      headers: { cookie: guest.cookie },
    });
    expect(characters.statusCode).toBe(200);
    expect((characters.json() as { characters: Array<{ characterId: number; characterName: string; isActive: boolean }> }).characters)
      .toEqual([
        { characterId: ALT_ID, characterName: ALT_NAME, isActive: false },
        { characterId: MAIN_ID, characterName: MAIN_NAME, isActive: true },
      ]);
  });

  it('carries an in-flight request of an orphaned lane through the merge', async () => {
    const first = await createBrowserSession();
    await linkCharacterViaSso(first, MAIN_ID, MAIN_NAME);
    await app.inject({ method: 'DELETE', url: '/api/web/session', headers: mutationHeaders(first) });

    // A runner that outlived the session: still in flight on the orphaned lane.
    const orphanThreadId = insertThread(first.userId, first.chatId);
    insertAgentRequest({
      requestId: 'in-flight-merge-01',
      userId: first.userId,
      chatId: first.chatId,
      threadId: orphanThreadId,
      idempotencyKey: 'in_flight_key_0000001',
      status: 'running',
    });

    const guest = await createBrowserSession();
    await linkCharacterViaSso(guest, MAIN_ID, MAIN_NAME);

    const moved = db.prepare(`
      SELECT user_id, chat_id, status FROM web_agent_requests WHERE request_id = 'in-flight-merge-01'
    `).get() as { user_id: number; chat_id: number; status: string };
    expect(moved).toEqual({ user_id: first.userId, chat_id: guest.chatId, status: 'running' });
    expect(db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(first.chatId)).toBeUndefined();

    // The same terminal write the coordinator does still lands on the moved row.
    const finished = db.prepare(`
      UPDATE web_agent_requests
      SET status = 'completed', result_text = ?, assistant_message_id = NULL, error_code = NULL,
          progress_sequence = progress_sequence + 1,
          cost_actual = cost_reserved,
          finished_at = datetime('now'), lease_expires_at = NULL, updated_at = datetime('now')
      WHERE request_id = ? AND status = 'running' AND cancel_requested = 0
    `).run('Готово', 'in-flight-merge-01');
    expect(finished.changes).toBe(1);

    const poll = await app.inject({
      method: 'GET',
      url: '/api/web/chat/requests/in-flight-merge-01',
      headers: { cookie: guest.cookie },
    });
    expect(poll.statusCode).toBe(200);
    expect((poll.json() as { request: { status: string; result: string | null } }).request)
      .toMatchObject({ status: 'completed', result: 'Готово' });
  });

  it('drops the guest duplicate on an idempotency-key collision and keeps the owner row', async () => {
    const first = await createBrowserSession();
    await linkCharacterViaSso(first, MAIN_ID, MAIN_NAME);
    await app.inject({ method: 'DELETE', url: '/api/web/session', headers: mutationHeaders(first) });

    const key = 'shared_idempotency_key_1';
    const ownerThreadId = insertThread(first.userId, first.chatId);
    insertAgentRequest({
      requestId: 'owner-completed-01',
      userId: first.userId,
      chatId: first.chatId,
      threadId: ownerThreadId,
      idempotencyKey: key,
      status: 'completed',
    });

    const guest = await createBrowserSession();
    const guestThreadId = insertThread(guest.userId, guest.chatId);
    insertAgentRequest({
      requestId: 'guest-completed-01',
      userId: guest.userId,
      chatId: guest.chatId,
      threadId: guestThreadId,
      idempotencyKey: key,
      status: 'completed',
    });

    await linkCharacterViaSso(guest, MAIN_ID, MAIN_NAME);

    expect(db.prepare('SELECT 1 FROM web_agent_requests WHERE request_id = ?').get('guest-completed-01'))
      .toBeUndefined();
    expect(db.prepare('SELECT user_id, chat_id FROM web_agent_requests WHERE request_id = ?').get('owner-completed-01'))
      .toEqual({ user_id: first.userId, chat_id: guest.chatId });
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(guest.userId)).toBeUndefined();
  });
});
