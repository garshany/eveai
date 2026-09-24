import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Bot, Context } from 'grammy';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

// Mock one level below runAgentTurn so the real in-flight/abort wiring runs.
const { runAgentTurnMock } = vi.hoisted(() => ({ runAgentTurnMock: vi.fn() }));
vi.mock('../../src/agent/executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/executor.js')>();
  return {
    ...actual,
    handleAgentMessage: async (...args: unknown[]) => ({ text: await runAgentTurnMock(...args), peakInputTokens: 0 }),
  };
});

import { registerHandlers } from '../../src/telegram/handlers.js';
import {
  activeRequestCount,
  clearChatConversationAfterInFlight,
  rememberInFlightRequest,
  resetChatRequestGuardForTests,
} from '../../src/chat/shared.js';
import { isTurnAborted, TURN_ABORTED_MESSAGE } from '../../src/agent/activity.js';

/**
 * A pending turn that honours the cooperative abort like the real executor.
 * `start` must run inside the turn (the abort probe lives in its async context).
 */
function pendingTurn(): { release: (value: string) => void; start: () => Promise<string> } {
  let release: (value: string) => void = () => {};
  const start = () => new Promise<string>((resolve, reject) => {
    release = (value) => {
      clearInterval(timer);
      resolve(value);
    };
    const timer = setInterval(() => {
      if (isTurnAborted()) {
        clearInterval(timer);
        reject(new Error(TURN_ABORTED_MESSAGE));
      }
    }, 5);
  });
  return { release: (value) => release(value), start };
}

type Handler = (ctx: Context, next?: () => Promise<void>) => Promise<void>;

function fakeBot() {
  const on = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const bot = {
    command: (name: string, handler: Handler) => { commands.set(name, handler); },
    on: (filter: string, handler: Handler) => { on.set(filter, handler); },
    callbackQuery: () => {},
  };
  return { bot: bot as unknown as Bot<Context>, on, commands };
}

function fakeCtx(userId: number, text: string) {
  const replies: string[] = [];
  const ctx = {
    chat: { id: userId, type: 'private' },
    from: { id: userId, username: `u${userId}`, first_name: 'Pilot' },
    message: { text, message_id: 1, date: Math.floor(Date.now() / 1000) },
    reply: vi.fn(async (msg: string) => { replies.push(msg); return { message_id: replies.length }; }),
    api: {
      deleteMessage: vi.fn(async () => true),
      sendChatAction: vi.fn(async () => true),
    },
  };
  return { ctx: ctx as unknown as Context, replies };
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetChatRequestGuardForTests();
  runAgentTurnMock.mockReset();
});

afterEach(() => {
  db.close();
});

describe('telegram text handler concurrency', () => {
  it('returns before the agent turn finishes so other updates are handled', async () => {
    const first = pendingTurn();
    runAgentTurnMock.mockImplementationOnce(() => first.start());
    runAgentTurnMock.mockImplementationOnce(async () => 'second answer');

    const { bot, on } = fakeBot();
    registerHandlers(bot, db);
    const textHandler = on.get('message:text')!;

    const firstUser = fakeCtx(101, 'first question');
    await textHandler(firstUser.ctx);
    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalledTimes(1));
    expect(activeRequestCount()).toBe(1);

    // Same actor while the first turn is pending: the guard must now engage.
    const again = fakeCtx(101, 'another question');
    await textHandler(again.ctx);
    expect(again.replies.join('\n')).toContain('Предыдущий запрос');

    // Another user's update is processed without waiting for the first turn.
    const second = fakeCtx(202, 'second question');
    await textHandler(second.ctx);
    await vi.waitFor(() => expect(second.replies).toContain('second answer'));

    first.release('first answer');
    await vi.waitFor(() => expect(firstUser.replies).toContain('first answer'));
    await vi.waitFor(() => expect(activeRequestCount()).toBe(0));
  });

  it('/clear during a running turn aborts it before deleting the thread', async () => {
    const turn = pendingTurn();
    runAgentTurnMock.mockImplementationOnce(() => turn.start());
    const { bot, on, commands } = fakeBot();
    registerHandlers(bot, db);

    const user = fakeCtx(101, 'long question');
    await on.get('message:text')!(user.ctx);
    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalledTimes(1));

    const clear = fakeCtx(101, '/clear');
    await commands.get('clear')!(clear.ctx);

    expect(clear.replies).toContain('Диалог очищен.');
    expect(activeRequestCount()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_threads WHERE chat_id = 101').get()).toEqual({ n: 0 });
    // The aborted turn neither answers nor reports an error; /clear speaks for it.
    expect(user.replies.some((reply) => reply !== user.replies[0])).toBe(false);
  });

  it('/clear gives up without deleting anything when the turn does not stop in time', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (404, 'u')").run();
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES ('t-404', 404)").run();
    rememberInFlightRequest(404, 't-404', 'stuck', 'token-404');
    await expect(clearChatConversationAfterInFlight(db as never, 404, 30, 5)).resolves.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_threads WHERE chat_id = 404').get()).toEqual({ n: 1 });
  });

  it('reports a failed detached turn and releases the in-flight entry', async () => {
    runAgentTurnMock.mockImplementationOnce(async () => { throw new Error('boom'); });
    const { bot, on } = fakeBot();
    registerHandlers(bot, db);

    const user = fakeCtx(303, 'question');
    await on.get('message:text')!(user.ctx);
    await vi.waitFor(() => expect(activeRequestCount()).toBe(0));
    expect(user.replies.length).toBeGreaterThanOrEqual(2);
  });
});
