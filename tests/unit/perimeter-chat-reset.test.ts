import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { registerMapRoutes, __testables } from '../../src/web/map-routes.js';
import { createWebSession, resetWebSessionCreationGuardForTests, WEB_SESSION_COOKIE } from '../../src/web/web-session.js';
import type { WebAgentRequestCoordinator } from '../../src/web/agent-requests.js';

const mocks = vi.hoisted(() => ({ compose: vi.fn(), enqueue: vi.fn() }));
vi.mock('../../src/eve-map/advisor-prose.js', () => ({ composeSituationAssessment: mocks.compose }));

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let headers: Record<string, string>;
beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  const session = createWebSession(db);
  headers = { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}`, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken };
  app = Fastify();
  await app.register(cookie);
  registerMapRoutes(app, db, { enqueue: mocks.enqueue } as unknown as WebAgentRequestCoordinator);
});
afterEach(async () => { await app.close(); db.close(); });
const history = () => app.inject({ method: 'GET', url: '/api/web/map/chat', headers });
const reset = () => app.inject({ method: 'POST', url: '/api/web/map/chat/reset', headers });

describe('Perimeter reset', () => {
  it('keeps the new thread after a late write updates the old one', async () => {
    const old = (await history()).json().threadId;
    db.prepare("INSERT INTO messages(thread_id, role, content) VALUES (?, 'assistant', 'old')").run(old);
    const cleared = (await reset()).json();
    expect(cleared.messages).toEqual([]);
    db.prepare("UPDATE agent_threads SET updated_at = '2099-01-01' WHERE thread_id = ?").run(old);
    expect((await history()).json()).toEqual(cleared);
  });
  it('resolves successive resets within the same SQLite timestamp deterministically', async () => {
    await history();
    await reset();
    const newest = (await reset()).json();
    db.prepare("UPDATE agent_threads SET updated_at = '2026-01-01'").run();
    expect((await history()).json()).toEqual(newest);
  });
  it('moves every open stream and publishes new warnings to the new thread', async () => {
    let current = (await history()).json().threadId;
    let other = current;
    const stream = () => ({ closed: false, send: vi.fn(), close: vi.fn(), onClose: vi.fn(), abortBeforeStart: vi.fn() });
    const first = stream();
    const second = stream();
    const leaveFirst = __testables.followThreadAudience(current, first, (id) => { current = id; });
    const leaveSecond = __testables.followThreadAudience(other, second, (id) => { other = id; });
    try {
      const cleared = (await reset()).json();
      expect(current).toBe(cleared.threadId);
      expect(other).toBe(current);
      expect(first.send).toHaveBeenCalledWith('chat-reset', { threadId: current });
      __testables.publishAdvisory(db, current, 42, {
        rule: 'camp_next_hop', severity: 'danger', text: { ru: 'Новый кемп', en: 'New camp' },
        systemId: 30000001, killmailId: null, repeats: 0, at: new Date().toISOString(),
      }, 'ru', first);
      expect(second.send).toHaveBeenCalledWith('advisory', expect.objectContaining({ threadId: current }));
      expect((await history()).json().messages.map((m: { content: string }) => m.content)).toEqual(['Новый кемп']);
      await reset();
      expect((await history()).json().messages).toEqual([]);
    } finally { leaveFirst(); leaveSecond(); }
  });
  it('discards a model assessment that finishes after reset', async () => {
    const old = (await history()).json().threadId;
    const owner = db.prepare('SELECT user_id AS userId, chat_id AS chatId FROM agent_threads WHERE thread_id = ?').get(old) as { userId: number; chatId: number };
    let finish!: (text: string) => void;
    mocks.compose.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const send = vi.fn();
    const pending = __testables.publishSituationAssessment(db, {
      threadId: old, characterId: null as never, owner, advisories: [], bubble: {} as never,
      origin: 30000001, routeAhead: [], locale: 'ru',
      stream: { closed: false, send, close() {}, onClose() {}, abortBeforeStart() {} },
    });
    const cleared = (await reset()).json();
    finish('Old model assessment');
    await pending;
    expect(send).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect((await history()).json()).toEqual(cleared);
  });
  it('enqueues the next question on the new thread, even after an old answer lands', async () => {
    const old = (await history()).json().threadId;
    const cleared = (await reset()).json();
    db.prepare("UPDATE agent_threads SET updated_at = '2099-01-01' WHERE thread_id = ?").run(old);
    mocks.enqueue.mockReturnValue({ ok: true, request: { requestId: 'test-request' } });
    const response = await app.inject({ method: 'POST', url: '/api/web/map/ask', headers, payload: { message: 'New question' } });
    expect(response.statusCode).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ threadId: cleared.threadId }));
  });
  it('rejects reset without CSRF and isolates another lane', async () => {
    const current = (await history()).json();
    const rejected = await app.inject({ method: 'POST', url: '/api/web/map/chat/reset', headers: { cookie: headers.cookie! } });
    expect(rejected.statusCode).toBe(403);
    const other = createWebSession(db);
    await app.inject({ method: 'POST', url: '/api/web/map/chat/reset', headers: { origin: 'http://localhost:3000', cookie: `${WEB_SESSION_COOKIE}=${other.sessionToken}`, 'x-csrf-token': other.csrfToken } });
    expect((await history()).json()).toEqual(current);
  });
});
