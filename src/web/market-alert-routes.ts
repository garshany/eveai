import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { cleanExpiredWebSessions } from './web-session.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';

/**
 * Price-alert HTTP API under /api/web/market/alerts. Alerts are one-shot rows
 * in market_price_alerts, evaluated by the market alerts worker against the
 * local market_orders snapshot; firings land in market_alert_events.
 *
 * Reads sit behind a browser session (401 without one), mutations
 * additionally verify the origin/CSRF pair (403 without it) via the shared
 * web-route guards. Everything reads local tables only — no ESI calls on the
 * request path.
 *
 * DELETE is a soft delete (status='disabled') for every status, not a
 * physical delete: market_alert_events resolves its region through the alert
 * row, and a removed row would strip region names from the event history.
 * Disabled rows are filtered out of every list, so the semantics from the
 * client's side are still "the alert is gone".
 */

type AlertRow = {
  alert_id: number;
  type_id: number;
  type_name: string | null;
  region_id: number;
  region_name: string | null;
  side: 'sell' | 'buy';
  comparator: 'above' | 'below';
  threshold_price: number;
  status: 'active' | 'triggered' | 'disabled';
  created_at: string;
  triggered_at: string | null;
  trigger_price: number | null;
  best_price: number | null;
};

type AlertEventRow = {
  event_id: number;
  alert_id: number;
  type_id: number;
  type_name: string | null;
  region_id: number | null;
  region_name: string | null;
  price: number;
  threshold: number;
  triggered_at: string;
  delivered_at: string | null;
};

type CreateAlertBody = {
  type_id?: unknown;
  region_id?: unknown;
  side?: unknown;
  comparator?: unknown;
  threshold_price?: unknown;
};

type AlertParams = { alertId: string };

const ALERT_SIDES = new Set(['sell', 'buy']);
const ALERT_COMPARATORS = new Set(['above', 'below']);
// Triggered alerts stay listed for a month; the cap is a safety rail for the
// panel, not a quota (active alerts are already capped per user on creation).
const RECENT_TRIGGERED_DAYS = 30;
const ALERT_LIST_LIMIT = 200;
const ALERT_EVENTS_LIMIT = 50;

// Current best price for the alert's side: best ask for 'sell' alerts, best
// bid for 'buy' alerts. NULL when the book has no orders for the pair.
const BEST_PRICE_SQL = `
  CASE a.side
    WHEN 'sell' THEN (
      SELECT MIN(o.price) FROM market_orders o
      WHERE o.region_id = a.region_id AND o.type_id = a.type_id AND o.is_buy_order = 0
    )
    ELSE (
      SELECT MAX(o.price) FROM market_orders o
      WHERE o.region_id = a.region_id AND o.type_id = a.type_id AND o.is_buy_order = 1
    )
  END
`;

const ALERT_ROW_SELECT = `
  SELECT a.alert_id, a.type_id, t.name AS type_name, a.region_id, r.name AS region_name,
    a.side, a.comparator, a.threshold_price, a.status, a.created_at, a.triggered_at,
    a.trigger_price, ${BEST_PRICE_SQL} AS best_price
  FROM market_price_alerts a
  LEFT JOIN sde_types t ON t.type_id = a.type_id
  LEFT JOIN sde_regions r ON r.region_id = a.region_id
`;

export function registerMarketAlertRoutes(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/web/market/alerts')) {
      void cleanExpiredWebSessions(db);
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.get('/api/web/market/alerts', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const alerts = db.prepare(`
      ${ALERT_ROW_SELECT}
      WHERE a.user_id = ?
        AND (
          a.status = 'active'
          OR (a.status = 'triggered' AND a.triggered_at >= datetime('now', '-${RECENT_TRIGGERED_DAYS} days'))
        )
      ORDER BY (a.status = 'active') DESC, a.alert_id DESC
      LIMIT ${ALERT_LIST_LIMIT}
    `).all(session.userId) as AlertRow[];
    return { ok: true, alerts };
  });

  app.post<{ Body: CreateAlertBody }>('/api/web/market/alerts', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const body = request.body ?? {};

    const typeId = asPositiveInt(body.type_id);
    const type = typeId === null
      ? undefined
      : db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
    if (typeId === null || !type) {
      return reply.status(404).send({ error: 'Предмет не найден.' });
    }

    const regionId = asPositiveInt(body.region_id);
    const region = regionId === null
      ? undefined
      : db.prepare('SELECT name FROM sde_regions WHERE region_id = ?').get(regionId) as { name: string } | undefined;
    if (regionId === null || !region) {
      return reply.status(400).send({ error: 'Неизвестный регион.' });
    }

    if (typeof body.side !== 'string' || !ALERT_SIDES.has(body.side)) {
      return reply.status(400).send({ error: "Сторона должна быть 'sell' или 'buy'." });
    }
    if (typeof body.comparator !== 'string' || !ALERT_COMPARATORS.has(body.comparator)) {
      return reply.status(400).send({ error: "Условие должно быть 'above' или 'below'." });
    }
    const threshold = body.threshold_price;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) {
      return reply.status(400).send({ error: 'Пороговая цена должна быть положительным числом.' });
    }

    const activeCount = db.prepare(`
      SELECT COUNT(*) AS n FROM market_price_alerts WHERE user_id = ? AND status = 'active'
    `).get(session.userId) as { n: number };
    if (activeCount.n >= config.marketAlerts.maxActivePerUser) {
      return reply.status(409).send({
        error: `Слишком много активных алертов (максимум ${config.marketAlerts.maxActivePerUser}).`,
      });
    }

    const inserted = db.prepare(`
      INSERT INTO market_price_alerts (user_id, type_id, region_id, side, comparator, threshold_price)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(session.userId, typeId, regionId, body.side, body.comparator, threshold);
    const alert = db.prepare(`${ALERT_ROW_SELECT} WHERE a.alert_id = ?`)
      .get(inserted.lastInsertRowid) as AlertRow;
    return reply.status(201).send({ ok: true, alert });
  });

  app.delete<{ Params: AlertParams }>('/api/web/market/alerts/:alertId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const alertId = parsePositiveInteger(request.params.alertId);
    // Soft delete; see the module header. Re-disabling an owned alert is
    // idempotent (SQLite counts the matched row even when the value is
    // unchanged), so only a missing or foreign alert yields 404.
    const changed = alertId === null
      ? 0
      : db.prepare(`
          UPDATE market_price_alerts SET status = 'disabled'
          WHERE alert_id = ? AND user_id = ?
        `).run(alertId, session.userId).changes;
    if (changed === 0) return reply.status(404).send({ error: 'Алерт не найден.' });
    return { ok: true };
  });

  app.get('/api/web/market/alerts/events', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const events = db.prepare(`
      SELECT e.event_id, e.alert_id, e.type_id, t.name AS type_name,
        a.region_id, r.name AS region_name,
        e.price, e.threshold, e.triggered_at, e.delivered_at
      FROM market_alert_events e
      LEFT JOIN sde_types t ON t.type_id = e.type_id
      LEFT JOIN market_price_alerts a ON a.alert_id = e.alert_id
      LEFT JOIN sde_regions r ON r.region_id = a.region_id
      WHERE e.user_id = ?
      ORDER BY e.event_id DESC
      LIMIT ${ALERT_EVENTS_LIMIT}
    `).all(session.userId) as AlertEventRow[];
    return { ok: true, events };
  });
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
