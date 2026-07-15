import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

const { runAgentTurnMock } = vi.hoisted(() => ({ runAgentTurnMock: vi.fn() }));
vi.mock('../../src/chat/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chat/shared.js')>();
  return { ...actual, runAgentTurn: runAgentTurnMock };
});

import { registerWebChatRoutes } from '../../src/web/chat-routes.js';
import { resetChatRequestGuardForTests } from '../../src/chat/shared.js';
import { resetWebSessionCreationGuardForTests } from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';

type BrowserSession = {
  cookie: string;
  csrf: string;
  userId: number;
  chatId: number;
};

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetChatRequestGuardForTests();
  resetWebSessionCreationGuardForTests();
  runAgentTurnMock.mockReset();
  runAgentTurnMock.mockImplementation(async (
    database: Database.Database,
    threadId: string,
    _ctx: unknown,
    text: string,
  ) => {
    database.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'user', text);
    const answer = `Ответ: ${text}`;
    database.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'assistant', answer);
    return answer;
  });
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerWebChatRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
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

describe('web chat routes', () => {
  it('creates isolated hashed browser sessions in the reserved chat range', async () => {
    const first = await createBrowserSession();
    const second = await createBrowserSession();

    expect(first.userId).not.toBe(second.userId);
    expect(first.chatId).toBeLessThanOrEqual(-2_000_000_000);
    expect(second.chatId).toBeLessThan(first.chatId);
    const rows = db.prepare('SELECT session_hash, csrf_hash FROM web_sessions').all() as Array<{
      session_hash: string;
      csrf_hash: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.session_hash.startsWith('h1:') && row.csrf_hash.startsWith('h1:'))).toBe(true);
    expect(first.cookie).not.toContain(rows[0]?.session_hash ?? 'never');
  });

  it('rejects cross-origin bootstrap and missing CSRF on mutations', async () => {
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/web/session',
      headers: { origin: 'https://attacker.invalid' },
    });
    expect(blocked.statusCode).toBe(403);

    const session = await createBrowserSession();
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: { origin: ORIGIN, cookie: session.cookie },
    });
    expect(missingCsrf.statusCode).toBe(403);
  });

  it('keeps an existing CSRF token stable across concurrent session reads', async () => {
    const session = await createBrowserSession();
    const [first, second] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/web/session',
        headers: { cookie: session.cookie },
      }),
      app.inject({
        method: 'GET',
        url: '/api/web/session',
        headers: { cookie: session.cookie },
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ session: { csrfToken: session.csrf } });
    expect(second.json()).toMatchObject({ session: { csrfToken: session.csrf } });
    const mutation = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    expect(mutation.statusCode).toBe(201);
  });

  it('rate-limits anonymous session creation before unbounded rows reach SQLite', async () => {
    for (let index = 0; index < 30; index += 1) {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/web/session',
        headers: { origin: ORIGIN },
      });
      expect(accepted.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/web/session',
      headers: { origin: ORIGIN },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('600');
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()).toEqual({ n: 30 });
  });

  it('purges the old browser identity and allocates a usable lane after logout', async () => {
    const first = await createBrowserSession();
    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/web/session',
      headers: mutationHeaders(first),
    });
    expect(logout.statusCode).toBe(204);
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(first.userId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(first.chatId)).toBeUndefined();

    const second = await createBrowserSession();
    expect(second.chatId).toBeLessThanOrEqual(-2_000_000_000);
    expect(second.userId).not.toBe(first.userId);
  });

  it('starts an OAuth request bound to the browser user and local app redirect', async () => {
    const session = await createBrowserSession();
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/eve/login',
      headers: mutationHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { url: string }).url).toContain('/auth/eve/login?state=');
    const auth = db.prepare('SELECT user_id, chat_id, redirect_url, state FROM auth_requests').get() as {
      user_id: number;
      chat_id: number;
      redirect_url: string;
      state: string;
    };
    expect(auth).toMatchObject({ user_id: session.userId, chat_id: session.chatId, redirect_url: '/app' });
    expect(auth.state.startsWith('h1:')).toBe(true);

    const repeated = await app.inject({
      method: 'POST',
      url: '/api/web/eve/login',
      headers: mutationHeaders(session),
    });
    expect(repeated.statusCode).toBe(200);
    expect(db.prepare(`
      SELECT COUNT(*) AS n
      FROM auth_requests
      WHERE user_id = ? AND chat_id = ? AND used_at IS NULL
    `).get(session.userId, session.chatId)).toEqual({ n: 1 });
  });

  it('creates, lists and runs a conversation through the shared agent seam', async () => {
    const session = await createBrowserSession();
    const created = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    const threadId = (created.json() as { threadId: string }).threadId;

    const answer = await app.inject({
      method: 'POST',
      url: '/api/web/chat',
      headers: mutationHeaders(session),
      payload: { message: 'Сравни цены', threadId },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ threadId, message: 'Ответ: Сравни цены' });
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(runAgentTurnMock.mock.calls[0]?.[2]).toMatchObject({ notificationCapability: 'none' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/web/conversations',
      headers: { cookie: session.cookie },
    });
    expect(list.json()).toMatchObject({ conversations: [{ id: threadId, title: 'Сравни цены' }] });

    const history = await app.inject({
      method: 'GET',
      url: `/api/web/conversations/${threadId}/messages`,
      headers: { cookie: session.cookie },
    });
    expect((history.json() as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it('does not allow one browser session to read another session conversation', async () => {
    const owner = await createBrowserSession();
    const intruder = await createBrowserSession();
    const created = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(owner),
    });
    const threadId = (created.json() as { threadId: string }).threadId;

    const response = await app.inject({
      method: 'GET',
      url: `/api/web/conversations/${threadId}/messages`,
      headers: { cookie: intruder.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('reuses one empty conversation and caps durable conversation growth', async () => {
    const session = await createBrowserSession();
    const first = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    expect(second.json()).toEqual(first.json());

    const initialId = (first.json() as { threadId: string }).threadId;
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', 'used')").run(initialId);
    for (let index = 1; index < 40; index += 1) {
      const threadId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      db.prepare(`
        INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)
      `).run(threadId, session.chatId, session.userId);
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', 'used')").run(threadId);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    expect(blocked.statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_threads WHERE chat_id = ?').get(session.chatId))
      .toEqual({ n: 40 });
  });

  it('does not reuse an empty conversation belonging to another active character', async () => {
    const session = await createBrowserSession();
    const insertAccount = db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (?, ?, 'enc:a', 'enc:r', datetime('now', '+1 hour'), '[]', ?)
    `);
    insertAccount.run(9101, 'Pilot A', session.userId);
    insertAccount.run(9102, 'Pilot B', session.userId);
    db.prepare(`
      INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)
    `).run(session.chatId, 9101, session.userId);
    db.prepare(`
      INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)
    `).run(session.chatId, 9102, session.userId);
    db.prepare('UPDATE users SET active_character_id = 9101 WHERE user_id = ?').run(session.userId);
    db.prepare('UPDATE telegram_sessions SET active_character_id = 9101 WHERE chat_id = ?').run(session.chatId);

    const first = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    const activate = await app.inject({
      method: 'POST',
      url: '/api/web/characters/9102/activate',
      headers: mutationHeaders(session),
    });
    expect(activate.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });

    const firstId = (first.json() as { threadId: string }).threadId;
    const secondId = (second.json() as { threadId: string }).threadId;
    expect(secondId).not.toBe(firstId);
    expect(db.prepare(`
      SELECT thread_id, character_id
      FROM agent_threads
      WHERE thread_id IN (?, ?)
      ORDER BY character_id
    `).all(firstId, secondId)).toEqual([
      { thread_id: firstId, character_id: 9101 },
      { thread_id: secondId, character_id: 9102 },
    ]);
  });

  it('returns the newest 200 conversation messages in chronological order', async () => {
    const session = await createBrowserSession();
    const created = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    const threadId = (created.json() as { threadId: string }).threadId;
    const insert = db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)");
    for (let index = 1; index <= 205; index += 1) insert.run(threadId, `message-${index}`);

    const history = await app.inject({
      method: 'GET',
      url: `/api/web/conversations/${threadId}/messages`,
      headers: { cookie: session.cookie },
    });
    const messages = (history.json() as { messages: Array<{ content: string }> }).messages;
    expect(messages).toHaveLength(200);
    expect(messages[0]?.content).toBe('message-6');
    expect(messages[199]?.content).toBe('message-205');
  });

  it('purges browser-only durable data when its session expires', async () => {
    const session = await createBrowserSession();
    const created = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(session),
    });
    const threadId = (created.json() as { threadId: string }).threadId;
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', 'private')").run(threadId);
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (9001, 'Expired Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), '[]', ?)
    `).run(session.userId);
    db.prepare(`
      INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, 9001, ?)
    `).run(session.chatId, session.userId);
    db.prepare(`
      INSERT INTO route_monitors (
        chat_id, character_id, origin_id, destination_id, route_systems
      ) VALUES (?, 9001, 30000142, 30002187, '[30000142,30002187]')
    `).run(session.chatId);
    db.prepare("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE chat_id = ?")
      .run(session.chatId);

    const expired = await app.inject({
      method: 'GET',
      url: '/api/web/session',
      headers: { cookie: session.cookie },
    });
    expect(expired.json()).toMatchObject({ session: null });
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(session.userId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(session.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM agent_threads WHERE thread_id = ?').get(threadId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = 9001').get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = ?').get(session.chatId)).toBeUndefined();
  });

  it('rejects cross-session delete, chat, and character activation mutations', async () => {
    const owner = await createBrowserSession();
    const intruder = await createBrowserSession();
    const created = await app.inject({
      method: 'POST',
      url: '/api/web/conversations',
      headers: mutationHeaders(owner),
    });
    const threadId = (created.json() as { threadId: string }).threadId;
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (9002, 'Owner Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), '[]', ?)
    `).run(owner.userId);
    db.prepare(`
      INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, 9002, ?)
    `).run(owner.chatId, owner.userId);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/web/conversations/${threadId}`,
      headers: mutationHeaders(intruder),
    });
    const chat = await app.inject({
      method: 'POST',
      url: '/api/web/chat',
      headers: mutationHeaders(intruder),
      payload: { threadId, message: 'steal' },
    });
    const activate = await app.inject({
      method: 'POST',
      url: '/api/web/characters/9002/activate',
      headers: mutationHeaders(intruder),
    });
    expect(remove.statusCode).toBe(404);
    expect(chat.statusCode).toBe(404);
    expect(activate.statusCode).toBe(404);
  });
});
