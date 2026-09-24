import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Bot, Context } from 'grammy';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

const { runAgentTurnMock } = vi.hoisted(() => ({ runAgentTurnMock: vi.fn() }));
vi.mock('../../src/chat/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chat/shared.js')>();
  return { ...actual, runAgentTurn: runAgentTurnMock };
});

import { registerHandlers } from '../../src/telegram/handlers.js';
import { activeRequestCount, resetChatRequestGuardForTests } from '../../src/chat/shared.js';

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
    let finishFirst: (value: string) => void = () => {};
    runAgentTurnMock.mockImplementationOnce(() => new Promise<string>((resolve) => { finishFirst = resolve; }));
    runAgentTurnMock.mockImplementationOnce(async () => 'second answer');

    const { bot, on, commands } = fakeBot();
    registerHandlers(bot, db);
    const textHandler = on.get('message:text')!;

    const first = fakeCtx(101, 'first question');
    await textHandler(first.ctx);
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

    // /clear from the first user also runs while their turn is pending.
    const clear = fakeCtx(101, '/clear');
    await commands.get('clear')!(clear.ctx);
    expect(clear.replies).toContain('Диалог очищен.');

    finishFirst('first answer');
    await vi.waitFor(() => expect(first.replies).toContain('first answer'));
    await vi.waitFor(() => expect(activeRequestCount()).toBe(0));
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
