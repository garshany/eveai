import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import {
  TURN_ABORTED_MESSAGE,
  TURN_DEADLINE_MESSAGE,
  runWithActivitySink,
  type AgentActivityEvent,
} from '../agent/activity.js';
import { normalizeAgentRuntimeError, runAgentTurn } from '../chat/shared.js';
import type { UserContext } from '../auth/user-resolver.js';

export type WebAgentRequestStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type WebAgentRequestDto = {
  requestId: string;
  threadId: string;
  status: WebAgentRequestStatus;
  activity: Array<{ name: string; detail?: string }>;
  progressSequence: number;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryAfterMs: number;
};

type RequestRow = {
  request_id: string;
  user_id: number;
  chat_id: number;
  thread_id: string;
  character_id: number | null;
  character_version: number;
  message: string;
  message_hash: string;
  idempotency_key: string;
  status: WebAgentRequestStatus;
  activity_json: string;
  progress_sequence: number;
  result_text: string | null;
  error_code: string | null;
  cancel_requested: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type WebAgentRequestOwner = {
  userId: number;
  chatId: number;
};

export type EnqueueWebAgentRequestInput = WebAgentRequestOwner & {
  threadId: string;
  characterId: number | null;
  characterVersion: number;
  message: string;
  idempotencyKey: string;
  ipKey: string;
};

export type EnqueueResult =
  | { ok: true; request: WebAgentRequestDto; existing: boolean }
  | { ok: false; statusCode: 409 | 429 | 503; error: string; retryAfterSeconds: number };

type AgentRunner = (
  db: Db,
  threadId: string,
  ctx: UserContext,
  text: string,
  options?: { userMessagePersisted?: boolean; backgroundProfileRefresh?: boolean },
) => Promise<string>;

const MAX_ACTIVITY_ITEMS = 32;
const MAX_ACTIVITY_DETAIL_CHARS = 160;
const REQUEST_COST_UNITS = 4;

export class WebAgentRequestCoordinator {
  private readonly running = new Map<string, AbortController>();
  private draining = false;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly runner: AgentRunner = runAgentTurn,
  ) {}

  start(): void {
    this.recoverAfterRestart();
    this.scheduleDrain();
  }

  enqueue(input: EnqueueWebAgentRequestInput, now = Date.now()): EnqueueResult {
    const messageHash = hashMessage(input.threadId, input.message);
    const transaction = this.db.transaction((): EnqueueResult => {
      const existing = this.db.prepare(`
        SELECT * FROM web_agent_requests
        WHERE user_id = ? AND chat_id = ? AND idempotency_key = ?
      `).get(input.userId, input.chatId, input.idempotencyKey) as RequestRow | undefined;
      if (existing) {
        if (existing.thread_id !== input.threadId || existing.message_hash !== messageHash) {
          return rejection(409, 'Ключ повторной отправки уже использован другим запросом.', 0);
        }
        return { ok: true, request: toDto(existing), existing: true };
      }

      const activeForUser = count(this.db, `
        SELECT COUNT(*) AS count FROM web_agent_requests
        WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
      `, input.userId, input.chatId);
      if (activeForUser >= config.web.maxQueuedAgentRequestsPerUser) {
        return rejection(429, 'Предыдущий запрос ещё обрабатывается. Дождитесь результата.', 5);
      }

      const activeGlobal = count(this.db, `
        SELECT COUNT(*) AS count FROM web_agent_requests
        WHERE status IN ('queued', 'running')
      `);
      if (activeGlobal >= config.web.maxQueuedAgentRequests) {
        return rejection(503, 'Очередь сервиса заполнена. Попробуйте позже.', 15);
      }

      const windowStart = now - config.web.requestWindowSeconds * 1000;
      const userRecent = count(this.db, `
        SELECT COUNT(*) AS count FROM web_agent_requests
        WHERE user_id = ? AND created_at_ms >= ?
      `, input.userId, windowStart);
      if (userRecent >= config.web.maxRequestsPerUserWindow) {
        return rejection(429, 'Слишком много запросов. Попробуйте позже.', config.web.requestWindowSeconds);
      }

      const globalRecent = count(this.db, `
        SELECT COUNT(*) AS count FROM web_agent_requests WHERE created_at_ms >= ?
      `, windowStart);
      const globalDay = count(this.db, `
        SELECT COUNT(*) AS count FROM web_agent_requests WHERE created_at_ms >= ?
      `, now - 86_400_000);
      if (
        globalRecent >= config.web.maxRequestsGlobalWindow
        || globalDay >= config.web.maxRequestsGlobalDay
      ) {
        return rejection(503, 'Сервис достиг безопасного лимита нагрузки. Попробуйте позже.', 60);
      }

      const userCost = sum(this.db, `
        SELECT COALESCE(SUM(cost_units), 0) AS total FROM web_admission_events
        WHERE event_kind = 'chat' AND user_id = ? AND created_at_ms >= ?
      `, input.userId, windowStart);
      const globalCost = sum(this.db, `
        SELECT COALESCE(SUM(cost_units), 0) AS total FROM web_admission_events
        WHERE event_kind = 'chat' AND created_at_ms >= ?
      `, windowStart);
      const dailyCost = sum(this.db, `
        SELECT COALESCE(SUM(cost_units), 0) AS total FROM web_admission_events
        WHERE event_kind = 'chat' AND created_at_ms >= ?
      `, now - 86_400_000);
      if (
        userCost + REQUEST_COST_UNITS > config.web.maxCostUnitsPerUserWindow
        || globalCost + REQUEST_COST_UNITS > config.web.maxCostUnitsGlobalWindow
        || dailyCost + REQUEST_COST_UNITS > config.web.maxCostUnitsGlobalDay
      ) {
        return rejection(503, 'Сервис достиг безопасного лимита вычислений. Попробуйте позже.', 60);
      }

      const ipRecent = count(this.db, `
        SELECT COUNT(*) AS count FROM web_admission_events
        WHERE event_kind = 'chat' AND ip_key = ? AND created_at_ms >= ?
      `, input.ipKey, windowStart);
      if (ipRecent >= config.web.maxRequestsGlobalWindow) {
        return rejection(429, 'Слишком много запросов. Попробуйте позже.', config.web.requestWindowSeconds);
      }

      const requestId = randomUUID();
      this.db.prepare(`
        INSERT INTO messages (thread_id, role, content, web_request_id)
        VALUES (?, 'user', ?, ?)
      `).run(input.threadId, input.message, requestId);
      this.db.prepare(`
        INSERT INTO web_agent_requests (
          request_id, user_id, chat_id, thread_id, character_id, character_version,
          message, message_hash, idempotency_key, status, cost_reserved, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(
        requestId,
        input.userId,
        input.chatId,
        input.threadId,
        input.characterId,
        input.characterVersion,
        input.message,
        messageHash,
        input.idempotencyKey,
        REQUEST_COST_UNITS,
        now,
      );
      this.db.prepare(`
        INSERT INTO web_admission_events (event_id, event_kind, user_id, ip_key, cost_units, created_at_ms)
        VALUES (?, 'chat', ?, ?, ?, ?)
      `).run(requestId, input.userId, input.ipKey, REQUEST_COST_UNITS, now);
      return {
        ok: true,
        request: this.readOwned({ userId: input.userId, chatId: input.chatId }, requestId)!,
        existing: false,
      };
    });
    const result = transaction();
    if (result.ok && !result.existing) this.scheduleDrain();
    return result;
  }

  readOwned(owner: WebAgentRequestOwner, requestId: string): WebAgentRequestDto | null {
    const row = this.db.prepare(`
      SELECT * FROM web_agent_requests
      WHERE request_id = ? AND user_id = ? AND chat_id = ?
    `).get(requestId, owner.userId, owner.chatId) as RequestRow | undefined;
    return row ? toDto(row) : null;
  }

  readActive(owner: WebAgentRequestOwner, threadId?: string): WebAgentRequestDto | null {
    const row = this.db.prepare(`
      SELECT * FROM web_agent_requests
      WHERE user_id = ? AND chat_id = ?
        AND status IN ('queued', 'running')
        AND (? IS NULL OR thread_id = ?)
      ORDER BY created_at_ms DESC
      LIMIT 1
    `).get(owner.userId, owner.chatId, threadId ?? null, threadId ?? null) as RequestRow | undefined;
    return row ? toDto(row) : null;
  }

  cancel(owner: WebAgentRequestOwner, requestId: string): WebAgentRequestDto | null {
    const cancel = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM web_agent_requests
        WHERE request_id = ? AND user_id = ? AND chat_id = ?
      `).get(requestId, owner.userId, owner.chatId) as RequestRow | undefined;
      if (!row) return null;
      if (row.status === 'queued') {
        this.db.prepare(`
          UPDATE web_agent_requests
          SET status = 'cancelled', cancel_requested = 1, error_code = 'cancelled',
              progress_sequence = progress_sequence + 1,
              finished_at = datetime('now'), updated_at = datetime('now')
          WHERE request_id = ? AND status = 'queued'
        `).run(requestId);
        this.deleteCancelledMessages(requestId);
      } else if (row.status === 'running') {
        this.db.prepare(`
          UPDATE web_agent_requests
          SET cancel_requested = 1, updated_at = datetime('now')
          WHERE request_id = ? AND status = 'running'
        `).run(requestId);
      }
      return requestId;
    });
    const cancelledId = cancel();
    if (!cancelledId) return null;
    this.running.get(cancelledId)?.abort();
    return this.readOwned(owner, cancelledId);
  }

  cancelLane(owner: WebAgentRequestOwner): void {
    const rows = this.db.prepare(`
      SELECT request_id FROM web_agent_requests
      WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
    `).all(owner.userId, owner.chatId) as Array<{ request_id: string }>;
    for (const row of rows) this.cancel(owner, row.request_id);
  }

  async cancelLaneAndWait(owner: WebAgentRequestOwner): Promise<void> {
    this.cancelLane(owner);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const active = count(this.db, `
        SELECT COUNT(*) AS count FROM web_agent_requests
        WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
      `, owner.userId, owner.chatId);
      if (active === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE web_agent_requests
        SET status = 'cancelled', error_code = 'cancelled', cancel_requested = 1,
            progress_sequence = progress_sequence + 1,
            finished_at = datetime('now'), lease_expires_at = NULL, updated_at = datetime('now')
        WHERE user_id = ? AND chat_id = ? AND status IN ('queued', 'running')
      `).run(owner.userId, owner.chatId);
      this.db.prepare(`
        DELETE FROM messages
        WHERE web_request_id IN (
          SELECT request_id FROM web_agent_requests
          WHERE user_id = ? AND chat_id = ? AND status = 'cancelled'
        )
      `).run(owner.userId, owner.chatId);
    })();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
    const deadline = Date.now() + 5_000;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private recoverAfterRestart(): void {
    this.db.prepare(`
      UPDATE web_agent_requests
      SET status = 'failed', error_code = 'service_restarted', cost_actual = 0,
          progress_sequence = progress_sequence + 1,
          finished_at = datetime('now'), updated_at = datetime('now'),
          lease_expires_at = NULL
      WHERE status = 'running'
    `).run();
    this.db.prepare(`
      DELETE FROM web_agent_requests
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND created_at_ms < ?
    `).run(Date.now() - config.web.requestRetentionDays * 86_400_000);
    this.db.prepare(`
      DELETE FROM web_admission_events WHERE created_at_ms < ?
    `).run(Date.now() - Math.max(1, config.web.requestRetentionDays) * 86_400_000);
  }

  private scheduleDrain(): void {
    if (this.closed || this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.closed) return;
    while (this.running.size < config.web.maxConcurrentAgentRequests) {
      const row = this.claimNext();
      if (!row) return;
      const controller = new AbortController();
      this.running.set(row.request_id, controller);
      void this.execute(row, controller).finally(() => {
        this.running.delete(row.request_id);
        this.scheduleDrain();
      });
    }
  }

  private claimNext(): RequestRow | null {
    const claim = this.db.transaction(() => {
      const candidate = this.db.prepare(`
        SELECT queued.request_id FROM web_agent_requests queued
        WHERE queued.status = 'queued' AND queued.cancel_requested = 0
          AND NOT EXISTS (
            SELECT 1 FROM web_agent_requests running
            WHERE running.user_id = queued.user_id
              AND running.chat_id = queued.chat_id
              AND running.status = 'running'
          )
        ORDER BY created_at_ms ASC
        LIMIT 1
      `).get() as { request_id: string } | undefined;
      if (!candidate) return null;
      const result = this.db.prepare(`
        UPDATE web_agent_requests
        SET status = 'running', started_at = datetime('now'), heartbeat_at = datetime('now'),
            progress_sequence = progress_sequence + 1,
            lease_expires_at = datetime('now', '+45 seconds'), updated_at = datetime('now')
        WHERE request_id = ? AND status = 'queued' AND cancel_requested = 0
      `).run(candidate.request_id);
      if (result.changes !== 1) return null;
      return this.db.prepare('SELECT * FROM web_agent_requests WHERE request_id = ?')
        .get(candidate.request_id) as RequestRow;
    });
    return claim();
  }

  private async execute(row: RequestRow, controller: AbortController): Promise<void> {
    const identity = this.db.prepare(`
      SELECT active_character_id, active_character_version FROM users WHERE user_id = ?
    `).get(row.user_id) as { active_character_id: number | null; active_character_version: number } | undefined;
    if (
      !identity
      || identity.active_character_id !== row.character_id
      || identity.active_character_version !== row.character_version
    ) {
      this.finish(row.request_id, 'failed', null, 'identity_changed');
      return;
    }

    const heartbeat = setInterval(() => {
      this.db.prepare(`
        UPDATE web_agent_requests
        SET heartbeat_at = datetime('now'), lease_expires_at = datetime('now', '+45 seconds'),
            updated_at = datetime('now')
        WHERE request_id = ? AND status = 'running'
      `).run(row.request_id);
    }, 15_000);
    heartbeat.unref?.();
    const deadline = setTimeout(() => controller.abort(), config.web.agentDeadlineMs);
    deadline.unref?.();
    const ctx: UserContext = {
      userId: row.user_id,
      chatId: row.chat_id,
      notificationCapability: 'web',
    };
    try {
      const answer = await runWithActivitySink({
        reasoning: false,
        requestId: row.request_id,
        aborted: () => controller.signal.aborted || this.cancelWasRequested(row.request_id),
        emit: (event) => this.recordActivity(row.request_id, event),
      }, () => this.runner(this.db, row.thread_id, ctx, row.message, {
        userMessagePersisted: true,
        backgroundProfileRefresh: false,
      }));
      if (controller.signal.aborted || this.cancelWasRequested(row.request_id)) {
        this.finish(row.request_id, 'cancelled', null, 'cancelled');
      } else {
        this.finish(row.request_id, 'completed', answer, null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        controller.signal.aborted
        || message === TURN_ABORTED_MESSAGE
        || message === TURN_DEADLINE_MESSAGE
      ) {
        const deadlineExceeded = !this.cancelWasRequested(row.request_id);
        this.finish(row.request_id, deadlineExceeded ? 'failed' : 'cancelled', null,
          deadlineExceeded ? 'deadline_exceeded' : 'cancelled');
      } else {
        console.error('[web-agent] request failed category=agent_failure');
        this.finish(row.request_id, 'failed', null, safeErrorCode(normalizeAgentRuntimeError(error)));
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  }

  private cancelWasRequested(requestId: string): boolean {
    const row = this.db.prepare(`
      SELECT cancel_requested FROM web_agent_requests WHERE request_id = ?
    `).get(requestId) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  private recordActivity(requestId: string, event: AgentActivityEvent): void {
    if (event.type !== 'tool_start') return;
    const row = this.db.prepare(`
      SELECT activity_json FROM web_agent_requests WHERE request_id = ? AND status = 'running'
    `).get(requestId) as { activity_json: string } | undefined;
    if (!row) return;
    const activity = parseActivity(row.activity_json);
    const next = {
      name: event.name.slice(0, 80),
      ...(event.detail ? { detail: event.detail.slice(0, MAX_ACTIVITY_DETAIL_CHARS) } : {}),
    };
    if (activity.some((item) => item.name === next.name && item.detail === next.detail)) return;
    activity.push(next);
    this.db.prepare(`
      UPDATE web_agent_requests
      SET activity_json = ?, progress_sequence = progress_sequence + 1, updated_at = datetime('now')
      WHERE request_id = ? AND status = 'running'
    `).run(JSON.stringify(activity.slice(-MAX_ACTIVITY_ITEMS)), requestId);
  }

  private finish(
    requestId: string,
    status: 'completed' | 'failed' | 'cancelled',
    result: string | null,
    errorCode: string | null,
  ): void {
    const assistant = status === 'completed'
      ? this.db.prepare(`
          SELECT id FROM messages
          WHERE web_request_id = ? AND role = 'assistant'
          ORDER BY id DESC LIMIT 1
        `).get(requestId) as { id: number } | undefined
      : undefined;
    const completionGuard = status === 'cancelled' ? '' : 'AND cancel_requested = 0';
    const updated = this.db.prepare(`
      UPDATE web_agent_requests
      SET status = ?, result_text = ?, assistant_message_id = ?, error_code = ?,
          progress_sequence = progress_sequence + 1,
          cost_actual = CASE WHEN ? = 'completed' THEN cost_reserved ELSE 0 END,
          finished_at = datetime('now'), lease_expires_at = NULL, updated_at = datetime('now')
      WHERE request_id = ? AND status = 'running' ${completionGuard}
    `).run(status, result, assistant?.id ?? null, errorCode, status, requestId);
    if (updated.changes > 0) {
      if (status === 'cancelled') this.deleteCancelledMessages(requestId);
      return;
    }
    if (status === 'cancelled') {
      this.deleteCancelledMessages(requestId);
      return;
    }

    // Cancellation is cancel-wins: if it landed after the runner's last probe
    // but before this terminal commit, a late model response cannot overwrite it.
    this.db.prepare(`
      UPDATE web_agent_requests
      SET status = 'cancelled', result_text = NULL, assistant_message_id = NULL,
          error_code = 'cancelled', progress_sequence = progress_sequence + 1,
          cost_actual = 0, finished_at = datetime('now'), lease_expires_at = NULL,
          updated_at = datetime('now')
      WHERE request_id = ? AND status = 'running' AND cancel_requested = 1
    `).run(requestId);
    this.deleteCancelledMessages(requestId);
  }

  private deleteCancelledMessages(requestId: string): void {
    this.db.prepare(`
      DELETE FROM messages
      WHERE web_request_id = ?
        AND EXISTS (
          SELECT 1 FROM web_agent_requests
          WHERE request_id = ? AND status = 'cancelled'
        )
    `).run(requestId, requestId);
  }
}

function toDto(row: RequestRow): WebAgentRequestDto {
  return {
    requestId: row.request_id,
    threadId: row.thread_id,
    status: row.status,
    activity: parseActivity(row.activity_json),
    progressSequence: row.progress_sequence,
    result: row.status === 'completed' ? row.result_text : null,
    error: publicError(row.error_code),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    retryAfterMs: row.status === 'queued' || row.status === 'running' ? 1_000 : 0,
  };
}

function parseActivity(value: string): Array<{ name: string; detail?: string }> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_ACTIVITY_ITEMS).flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.name !== 'string') return [];
      return [{
        name: record.name.slice(0, 80),
        ...(typeof record.detail === 'string'
          ? { detail: record.detail.slice(0, MAX_ACTIVITY_DETAIL_CHARS) }
          : {}),
      }];
    });
  } catch {
    return [];
  }
}

function hashMessage(threadId: string, message: string): string {
  return createHash('sha256').update(threadId).update('\0').update(message).digest('hex');
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

function sum(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { total: number }).total;
}

function rejection(
  statusCode: 409 | 429 | 503,
  error: string,
  retryAfterSeconds: number,
): EnqueueResult {
  return { ok: false, statusCode, error, retryAfterSeconds };
}

function safeErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('перегруж')) return 'overloaded';
  if (normalized.includes('временно недоступ')) return 'provider_unavailable';
  return 'agent_failure';
}

function publicError(code: string | null): string | null {
  if (!code) return null;
  if (code === 'cancelled') return 'Запрос отменён.';
  if (code === 'deadline_exceeded') return 'Запрос превысил безопасный лимит времени. Попробуйте разбить задачу.';
  if (code === 'identity_changed') return 'Активный персонаж изменился. Повторите запрос.';
  if (code === 'service_restarted') return 'Сервис перезапустился во время запроса. Повторите запрос.';
  if (code === 'overloaded') return 'Сервис перегружен. Попробуйте позже.';
  if (code === 'provider_unavailable') return 'Модель временно недоступна. Попробуйте позже.';
  return 'Не удалось завершить запрос. Попробуйте ещё раз.';
}
