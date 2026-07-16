import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  isTurnAborted,
  reportActivity,
  TURN_ABORTED_MESSAGE,
  TURN_DEADLINE_MESSAGE,
} from '../../src/agent/activity.js';
import { WebAgentRequestCoordinator } from '../../src/web/agent-requests.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'owner')").run();
  db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (-2000000000, 'web')").run();
  db.prepare(`
    INSERT INTO agent_threads (thread_id, chat_id, user_id)
    VALUES ('thread-1', -2000000000, 1)
  `).run();
});

afterEach(() => {
  db.close();
});

describe('durable web agent request coordinator', () => {
  it('durably records cancellation and actively stops the running turn', async () => {
    const coordinator = new WebAgentRequestCoordinator(db, async () => {
      while (!isTurnAborted()) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(TURN_ABORTED_MESSAGE);
    });
    coordinator.start();
    const accepted = coordinator.enqueue(input('cancel_key_00000001'));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    await waitFor(() => coordinator.readOwned(owner(), accepted.request.requestId)?.status === 'running');
    const cancelled = coordinator.cancel(owner(), accepted.request.requestId);
    expect(cancelled?.requestId).toBe(accepted.request.requestId);
    await waitFor(() => coordinator.readOwned(owner(), accepted.request.requestId)?.status === 'cancelled');
    expect(coordinator.readOwned(owner(), accepted.request.requestId)).toMatchObject({
      status: 'cancelled',
      error: 'Запрос отменён.',
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM messages WHERE web_request_id = ?
    `).get(accepted.request.requestId)).toEqual({ count: 0 });
    await coordinator.close();
  });

  it('removes a queued prompt immediately when the user cancels it', async () => {
    const coordinator = new WebAgentRequestCoordinator(db, async () => 'must not run');
    const accepted = coordinator.enqueue(input('queued_cancel_key_01'));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const cancelled = coordinator.cancel(owner(), accepted.request.requestId);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM messages WHERE web_request_id = ?
    `).get(accepted.request.requestId)).toEqual({ count: 0 });
    await coordinator.close();
  });

  it('removes request messages when lane cancellation must force a stuck request terminal', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new WebAgentRequestCoordinator(db, async () => 'must not run');
      db.prepare(`
        INSERT INTO web_agent_requests (
          request_id, user_id, chat_id, thread_id, character_id, character_version,
          message, message_hash, idempotency_key, status, created_at_ms
        ) VALUES ('stuck-cancel', 1, -2000000000, 'thread-1', NULL, 0,
          'stuck', 'hash', 'stuck_cancel_key_01', 'running', ?)
      `).run(Date.now());
      db.prepare(`
        INSERT INTO messages (thread_id, role, content, web_request_id)
        VALUES ('thread-1', 'user', 'stuck', 'stuck-cancel')
      `).run();

      const cancellation = coordinator.cancelLaneAndWait(owner());
      await vi.advanceTimersByTimeAsync(5_100);
      await cancellation;

      expect(coordinator.readOwned(owner(), 'stuck-cancel')).toMatchObject({ status: 'cancelled' });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM messages WHERE web_request_id = 'stuck-cancel'
      `).get()).toEqual({ count: 0 });
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a root turn deadline as failed rather than completed', async () => {
    const coordinator = new WebAgentRequestCoordinator(db, async () => {
      throw new Error(TURN_DEADLINE_MESSAGE);
    });
    coordinator.start();
    const accepted = coordinator.enqueue(input('deadline_key_000001'));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    await waitFor(() => coordinator.readOwned(owner(), accepted.request.requestId)?.status === 'failed');
    expect(coordinator.readOwned(owner(), accepted.request.requestId)).toMatchObject({
      status: 'failed',
      error: 'Запрос превысил безопасный лимит времени. Попробуйте разбить задачу.',
    });
    await coordinator.close();
  });

  it('disables the unowned background profile refresh for durable web turns', async () => {
    let receivedOptions: { backgroundProfileRefresh?: boolean } | undefined;
    const coordinator = new WebAgentRequestCoordinator(db, async (
      _database,
      _threadId,
      _ctx,
      _text,
      options,
    ) => {
      receivedOptions = options;
      return 'done';
    });
    coordinator.start();
    const accepted = coordinator.enqueue(input('profile_guard_key_01'));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await waitFor(() => coordinator.readOwned(owner(), accepted.request.requestId)?.status === 'completed');
    expect(receivedOptions).toMatchObject({
      userMessagePersisted: true,
      backgroundProfileRefresh: false,
    });
    await coordinator.close();
  });

  it('binds the durable assistant pointer to its request under same-thread completion races', async () => {
    const coordinator = new WebAgentRequestCoordinator(db, async () => 'unused');
    for (const requestId of ['request-a', 'request-b']) {
      db.prepare(`
        INSERT INTO web_agent_requests (
          request_id, user_id, chat_id, thread_id, character_id, character_version,
          message, message_hash, idempotency_key, status, created_at_ms
        ) VALUES (?, 1, -2000000000, 'thread-1', NULL, 0,
          ?, ?, ?, 'running', ?)
      `).run(requestId, requestId, `${requestId}-hash`, `${requestId}-key-0001`, Date.now());
    }
    const assistantA = Number(db.prepare(`
      INSERT INTO messages (thread_id, role, content, web_request_id)
      VALUES ('thread-1', 'assistant', 'A', 'request-a')
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO messages (thread_id, role, content, web_request_id)
      VALUES ('thread-1', 'assistant', 'B', 'request-b')
    `).run();

    const finish = (coordinator as unknown as {
      finish: (requestId: string, status: 'completed', result: string, errorCode: null) => void;
    }).finish.bind(coordinator);
    finish('request-a', 'completed', 'A', null);

    expect(db.prepare(`
      SELECT assistant_message_id FROM web_agent_requests WHERE request_id = 'request-a'
    `).get()).toEqual({ assistant_message_id: assistantA });
    await coordinator.close();
  });

  it('makes a cancellation that lands before terminal commit win over completion', async () => {
    const coordinator = new WebAgentRequestCoordinator(db, async () => 'unused');
    db.prepare(`
      INSERT INTO web_agent_requests (
        request_id, user_id, chat_id, thread_id, character_id, character_version,
        message, message_hash, idempotency_key, status, cancel_requested, created_at_ms
      ) VALUES ('cancel-race', 1, -2000000000, 'thread-1', NULL, 0,
        'race', 'hash', 'cancel_race_key_01', 'running', 1, ?)
    `).run(Date.now());
    db.prepare(`
      INSERT INTO messages (thread_id, role, content, web_request_id)
      VALUES ('thread-1', 'assistant', 'late', 'cancel-race')
    `).run();

    const finish = (coordinator as unknown as {
      finish: (requestId: string, status: 'completed', result: string, errorCode: null) => void;
    }).finish.bind(coordinator);
    finish('cancel-race', 'completed', 'late', null);

    expect(coordinator.readOwned(owner(), 'cancel-race')).toMatchObject({
      status: 'cancelled',
      result: null,
      error: 'Запрос отменён.',
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE thread_id = 'thread-1' AND role = 'assistant'
    `).get()).toEqual({ count: 0 });
    await coordinator.close();
  });

  it('bounds and sanitizes durable progress while keeping the terminal result recoverable', async () => {
    const coordinator = new WebAgentRequestCoordinator(db, async () => {
      for (let index = 0; index < 50; index += 1) {
        reportActivity({ type: 'tool_start', name: `tool_${index}`, detail: 'x'.repeat(500) });
      }
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES ('thread-1', 'assistant', 'done')").run();
      return 'done';
    });
    coordinator.start();
    const accepted = coordinator.enqueue(input('progress_key_000001'));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await waitFor(() => coordinator.readOwned(owner(), accepted.request.requestId)?.status === 'completed');
    const result = coordinator.readOwned(owner(), accepted.request.requestId);
    expect(result).toMatchObject({ status: 'completed', result: 'done' });
    expect(result?.activity).toHaveLength(32);
    expect(Math.max(...(result?.activity.map((item) => item.detail?.length ?? 0) ?? []))).toBe(160);
    await coordinator.close();
  });

  it('never replays a request that was running when the process restarted', async () => {
    db.prepare(`
      INSERT INTO web_agent_requests (
        request_id, user_id, chat_id, thread_id, character_id, character_version,
        message, message_hash, idempotency_key, status, created_at_ms
      ) VALUES ('stale-1', 1, -2000000000, 'thread-1', NULL, 0,
        'unknown side effect', 'hash', 'stale_key_0000001', 'running', ?)
    `).run(Date.now());
    let executions = 0;
    const coordinator = new WebAgentRequestCoordinator(db, async () => {
      executions += 1;
      return 'must not run';
    });
    coordinator.start();
    expect(coordinator.readOwned(owner(), 'stale-1')).toMatchObject({
      status: 'failed',
      error: 'Сервис перезапустился во время запроса. Повторите запрос.',
    });
    expect(executions).toBe(0);
    await coordinator.close();
  });

  it('runs at most one request per browser lane while allowing queued work behind it', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const coordinator = new WebAgentRequestCoordinator(db, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return 'done';
    });
    const insert = db.prepare(`
      INSERT INTO web_agent_requests (
        request_id, user_id, chat_id, thread_id, character_id, character_version,
        message, message_hash, idempotency_key, status, created_at_ms
      ) VALUES (?, 1, -2000000000, 'thread-1', NULL, 0,
        ?, ?, ?, 'queued', ?)
    `);
    insert.run('lane-first', 'first', 'first-hash', 'lane_first_key_01', Date.now());
    insert.run('lane-second', 'second', 'second-hash', 'lane_second_key_1', Date.now() + 1);

    coordinator.start();
    await waitFor(() => active === 1);
    expect(coordinator.readOwned(owner(), 'lane-first')?.status).toBe('running');
    expect(coordinator.readOwned(owner(), 'lane-second')?.status).toBe('queued');

    releases.shift()?.();
    await waitFor(() => coordinator.readOwned(owner(), 'lane-second')?.status === 'running');
    expect(active).toBe(1);
    releases.shift()?.();
    await waitFor(() => coordinator.readOwned(owner(), 'lane-second')?.status === 'completed');
    expect(peak).toBe(1);
    await coordinator.close();
  });

  it('enforces the durable compute-unit circuit breaker before enqueue', async () => {
    db.prepare(`
      INSERT INTO web_admission_events (
        event_id, event_kind, user_id, ip_key, cost_units, created_at_ms
      ) VALUES ('budget', 'chat', 1, 'ip1:test', 24, ?)
    `).run(Date.now());
    const coordinator = new WebAgentRequestCoordinator(db, async () => 'must not run');
    coordinator.start();
    const rejected = coordinator.enqueue(input('budget_key_0000001'));
    expect(rejected).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'Сервис достиг безопасного лимита вычислений. Попробуйте позже.',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM web_agent_requests').get()).toEqual({ count: 0 });
    await coordinator.close();
  });
});

function owner() {
  return { userId: 1, chatId: -2_000_000_000 };
}

function input(idempotencyKey: string) {
  return {
    ...owner(),
    threadId: 'thread-1',
    characterId: null,
    characterVersion: 0,
    message: 'test request',
    idempotencyKey,
    ipKey: 'ip1:test',
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for coordinator state');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
