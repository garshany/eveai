import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';

/**
 * Общий допуск веб-эндпоинтов, жгущих вычисления (модель): окна запросов на
 * пользователя/глобально, IP-окно и дurable-бюджеты cost-units. Вынесено из
 * WebAgentRequestCoordinator.enqueue, чтобы /api/web/market/ai-search проходил
 * те же проверки, а не паразитную копию. Решение и запись события — одна
 * функция: событие пишется только при допуске, поэтому окна и бюджеты
 * учитывают исключительно принятую нагрузку. Вызывается внутри транзакции
 * вызывающей стороны (у enqueue) или самостоятельно (ai-search).
 *
 * Бюджеты cost-units — операторские и общие для всех event_kind: событие
 * ai-search тратит тот же пул WEB_MAX_COST_UNITS_*, что и чат. Отказы,
 * вызванные лимитом самого пользователя, — 429; глобальные предохранители — 503.
 */

export type WebAdmissionEventKind = 'session' | 'chat' | 'ai-search';

export type WebAdmissionInput = {
  eventKind: WebAdmissionEventKind;
  userId: number | null;
  ipKey: string;
  costUnits: number;
};

export type WebAdmissionDecision =
  | { ok: true }
  | { ok: false; statusCode: 429 | 503; error: string; retryAfterSeconds: number };

export function admitWebEvent(
  db: Db,
  input: WebAdmissionInput,
  now = Date.now(),
  eventId: string = randomUUID(),
): WebAdmissionDecision {
  const windowStart = now - config.web.requestWindowSeconds * 1000;
  const dayStart = now - 86_400_000;

  if (input.userId !== null) {
    const userRecent = count(db, `
      SELECT COUNT(*) AS count FROM web_admission_events
      WHERE event_kind = ? AND user_id = ? AND created_at_ms >= ?
    `, input.eventKind, input.userId, windowStart);
    if (userRecent >= config.web.maxRequestsPerUserWindow) {
      return rejection(429, 'Слишком много запросов. Попробуйте позже.', config.web.requestWindowSeconds);
    }
  }

  const globalRecent = count(db, `
    SELECT COUNT(*) AS count FROM web_admission_events
    WHERE event_kind = ? AND created_at_ms >= ?
  `, input.eventKind, windowStart);
  const globalDay = count(db, `
    SELECT COUNT(*) AS count FROM web_admission_events
    WHERE event_kind = ? AND created_at_ms >= ?
  `, input.eventKind, dayStart);
  if (
    globalRecent >= config.web.maxRequestsGlobalWindow
    || globalDay >= config.web.maxRequestsGlobalDay
  ) {
    return rejection(503, 'Сервис достиг безопасного лимита нагрузки. Попробуйте позже.', 60);
  }

  if (input.costUnits > 0) {
    const userCost = input.userId === null ? 0 : sum(db, `
      SELECT COALESCE(SUM(cost_units), 0) AS total FROM web_admission_events
      WHERE cost_units > 0 AND user_id = ? AND created_at_ms >= ?
    `, input.userId, windowStart);
    if (userCost + input.costUnits > config.web.maxCostUnitsPerUserWindow) {
      return rejection(429, 'Исчерпан лимит вычислений. Попробуйте позже.', 60);
    }
    const globalCost = sum(db, `
      SELECT COALESCE(SUM(cost_units), 0) AS total FROM web_admission_events
      WHERE cost_units > 0 AND created_at_ms >= ?
    `, windowStart);
    const dailyCost = sum(db, `
      SELECT COALESCE(SUM(cost_units), 0) AS total FROM web_admission_events
      WHERE cost_units > 0 AND created_at_ms >= ?
    `, dayStart);
    if (
      globalCost + input.costUnits > config.web.maxCostUnitsGlobalWindow
      || dailyCost + input.costUnits > config.web.maxCostUnitsGlobalDay
    ) {
      return rejection(503, 'Сервис достиг безопасного лимита вычислений. Попробуйте позже.', 60);
    }
  }

  const ipRecent = count(db, `
    SELECT COUNT(*) AS count FROM web_admission_events
    WHERE event_kind = ? AND ip_key = ? AND created_at_ms >= ?
  `, input.eventKind, input.ipKey, windowStart);
  if (ipRecent >= config.web.maxRequestsGlobalWindow) {
    return rejection(429, 'Слишком много запросов. Попробуйте позже.', config.web.requestWindowSeconds);
  }

  db.prepare(`
    INSERT INTO web_admission_events (event_id, event_kind, user_id, ip_key, cost_units, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(eventId, input.eventKind, input.userId, input.ipKey, input.costUnits, now);
  return { ok: true };
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

function sum(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { total: number }).total;
}

function rejection(
  statusCode: 429 | 503,
  error: string,
  retryAfterSeconds: number,
): WebAdmissionDecision {
  return { ok: false, statusCode, error, retryAfterSeconds };
}
