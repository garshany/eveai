import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { registerMarketAlertRoutes } from '../../src/web/market-alert-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';
const FORGE = 10000002;
const TRITANIUM = 34;
const PYERITE = 35;

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let orderId = 1;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  db.prepare("INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, 'Tritanium', 1, '{}')").run(TRITANIUM);
  db.prepare("INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, 'Pyerite', 1, '{}')").run(PYERITE);
  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, 'The Forge', '{}')").run(FORGE);
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerMarketAlertRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

function browserSession() {
  const created = createWebSession(db);
  return {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
  };
}

function mutationHeaders(session: ReturnType<typeof browserSession>) {
  return {
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
}

function addOrder(regionId: number, typeId: number, price: number, isBuyOrder: boolean): void {
  db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, region_id, system_id, station_id, location_id,
      is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued
    ) VALUES (?, ?, ?, 30000142, 60003760, 60003760, ?, ?, 100, 100, 1, 90, 'region', '2026-07-27T09:55:00Z')
  `).run(orderId, typeId, regionId, isBuyOrder ? 1 : 0, price);
  orderId += 1;
}

function addAlert(
  userId: number,
  overrides: Partial<{
    typeId: number;
    regionId: number;
    side: 'sell' | 'buy';
    comparator: 'above' | 'below';
    threshold: number;
    status: 'active' | 'triggered' | 'disabled';
  }> = {},
): number {
  const result = db.prepare(`
    INSERT INTO market_price_alerts (user_id, type_id, region_id, side, comparator, threshold_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    overrides.typeId ?? TRITANIUM,
    overrides.regionId ?? FORGE,
    overrides.side ?? 'sell',
    overrides.comparator ?? 'above',
    overrides.threshold ?? 100,
    overrides.status ?? 'active',
  );
  return Number(result.lastInsertRowid);
}

const VALID_BODY = {
  type_id: TRITANIUM,
  region_id: FORGE,
  side: 'sell',
  comparator: 'above',
  threshold_price: 100,
};

describe('market alert routes: auth', () => {
  it('rejects the alert list without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/market/alerts' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Сессия истекла. Обновите страницу.' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects the event list without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/market/alerts/events' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects mutations without a session, CSRF token, or matching origin', async () => {
    const session = browserSession();

    const noSession = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: { origin: ORIGIN },
      payload: VALID_BODY,
    });
    expect(noSession.statusCode).toBe(401);

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: VALID_BODY,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toEqual({ error: 'Проверка безопасности запроса не пройдена.' });

    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: { origin: 'https://attacker.invalid', cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: VALID_BODY,
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const deleteNoCsrf = await app.inject({
      method: 'DELETE',
      url: '/api/web/market/alerts/1',
      headers: { origin: ORIGIN, cookie: session.cookie },
    });
    expect(deleteNoCsrf.statusCode).toBe(403);
  });
});

describe('market alert routes: POST /api/web/market/alerts', () => {
  it('creates an alert and returns it with names and the current best price', async () => {
    const session = browserSession();
    addOrder(FORGE, TRITANIUM, 105, false);
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: mutationHeaders(session),
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(201);
    const payload = response.json() as { ok: boolean; alert: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.alert).toMatchObject({
      type_id: TRITANIUM,
      type_name: 'Tritanium',
      region_id: FORGE,
      region_name: 'The Forge',
      side: 'sell',
      comparator: 'above',
      threshold_price: 100,
      status: 'active',
      triggered_at: null,
      trigger_price: null,
      best_price: 105,
    });
    expect(payload.alert.alert_id).toEqual(expect.any(Number));
    expect(payload.alert.created_at).toEqual(expect.any(String));

    const stored = db.prepare(
      'SELECT user_id, status FROM market_price_alerts WHERE alert_id = ?',
    ).get(payload.alert.alert_id) as { user_id: number; status: string };
    expect(stored).toEqual({ user_id: session.userId, status: 'active' });
  });

  it('returns 404 when the type is unknown or malformed', async () => {
    const session = browserSession();
    const unknownType = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: mutationHeaders(session),
      payload: { ...VALID_BODY, type_id: 999999 },
    });
    expect(unknownType.statusCode).toBe(404);
    expect(unknownType.json()).toEqual({ error: 'Предмет не найден.' });

    const malformedType = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: mutationHeaders(session),
      payload: { ...VALID_BODY, type_id: 'tritanium' },
    });
    expect(malformedType.statusCode).toBe(404);
  });

  it('returns 400 when the region is unknown', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: mutationHeaders(session),
      payload: { ...VALID_BODY, region_id: 999999 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Неизвестный регион.' });
  });

  it('returns 400 for a bad side, comparator, or threshold', async () => {
    const session = browserSession();
    const cases: Array<Record<string, unknown>> = [
      { ...VALID_BODY, side: 'auction' },
      { ...VALID_BODY, comparator: 'equals' },
      { ...VALID_BODY, threshold_price: 0 },
      { ...VALID_BODY, threshold_price: -5 },
      { ...VALID_BODY, threshold_price: '100' },
    ];
    for (const payload of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/web/market/alerts',
        headers: mutationHeaders(session),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM market_price_alerts').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('returns 409 when the user is at the active-alert cap', async () => {
    const session = browserSession();
    for (let index = 0; index < 50; index += 1) {
      addAlert(session.userId, { threshold: 100 + index });
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: mutationHeaders(session),
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(409);

    // Disabled and triggered alerts do not count against the cap.
    db.prepare("UPDATE market_price_alerts SET status = 'disabled' WHERE user_id = ?").run(session.userId);
    const afterDisable = await app.inject({
      method: 'POST',
      url: '/api/web/market/alerts',
      headers: mutationHeaders(session),
      payload: VALID_BODY,
    });
    expect(afterDisable.statusCode).toBe(201);
  });
});

describe('market alert routes: GET /api/web/market/alerts', () => {
  it('lists active and recently triggered alerts with names, hiding disabled and stale ones', async () => {
    const session = browserSession();
    const activeId = addAlert(session.userId, { comparator: 'above', threshold: 100 });
    const triggeredId = addAlert(session.userId, { typeId: PYERITE, status: 'triggered', threshold: 200 });
    db.prepare("UPDATE market_price_alerts SET triggered_at = datetime('now', '-2 days'), trigger_price = 190 WHERE alert_id = ?").run(triggeredId);
    const staleTriggeredId = addAlert(session.userId, { status: 'triggered', threshold: 300 });
    db.prepare("UPDATE market_price_alerts SET triggered_at = datetime('now', '-31 days'), trigger_price = 290 WHERE alert_id = ?").run(staleTriggeredId);
    const disabledId = addAlert(session.userId, { status: 'disabled', threshold: 400 });
    addOrder(FORGE, TRITANIUM, 105, false);
    addOrder(FORGE, TRITANIUM, 108, false); // best ask stays 105

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/alerts',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const payload = response.json() as { ok: boolean; alerts: Array<Record<string, unknown>> };
    expect(payload.ok).toBe(true);
    const ids = payload.alerts.map((alert) => alert.alert_id);
    expect(ids).toContain(activeId);
    expect(ids).toContain(triggeredId);
    expect(ids).not.toContain(staleTriggeredId);
    expect(ids).not.toContain(disabledId);
    // Active alerts sort before triggered ones.
    expect(ids.indexOf(activeId)).toBeLessThan(ids.indexOf(triggeredId));

    const active = payload.alerts.find((alert) => alert.alert_id === activeId);
    expect(active).toMatchObject({
      type_name: 'Tritanium',
      region_name: 'The Forge',
      status: 'active',
      best_price: 105,
    });
    const triggered = payload.alerts.find((alert) => alert.alert_id === triggeredId);
    expect(triggered).toMatchObject({
      type_name: 'Pyerite',
      status: 'triggered',
      trigger_price: 190,
      best_price: null, // no Pyerite orders in the book
    });
  });

  it('does not list other users alerts', async () => {
    const mine = browserSession();
    const other = browserSession();
    addAlert(other.userId, {});
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/alerts',
      headers: { cookie: mine.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { alerts: unknown[] }).alerts).toHaveLength(0);
  });
});

describe('market alert routes: DELETE /api/web/market/alerts/:alertId', () => {
  it('soft-deletes an owned alert so it disappears from the list', async () => {
    const session = browserSession();
    const alertId = addAlert(session.userId, {});
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/web/market/alerts/${alertId}`,
      headers: mutationHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const stored = db.prepare('SELECT status FROM market_price_alerts WHERE alert_id = ?')
      .get(alertId) as { status: string };
    expect(stored.status).toBe('disabled');

    const list = await app.inject({
      method: 'GET',
      url: '/api/web/market/alerts',
      headers: { cookie: session.cookie },
    });
    expect((list.json() as { alerts: unknown[] }).alerts).toHaveLength(0);
  });

  it('returns 404 for a foreign, missing, or malformed alert id', async () => {
    const mine = browserSession();
    const other = browserSession();
    const foreignId = addAlert(other.userId, {});

    const foreign = await app.inject({
      method: 'DELETE',
      url: `/api/web/market/alerts/${foreignId}`,
      headers: mutationHeaders(mine),
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: 'Алерт не найден.' });
    // The foreign alert survived the attempt.
    expect(db.prepare('SELECT status FROM market_price_alerts WHERE alert_id = ?').get(foreignId))
      .toEqual({ status: 'active' });

    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/web/market/alerts/424242',
      headers: mutationHeaders(mine),
    });
    expect(missing.statusCode).toBe(404);

    const malformed = await app.inject({
      method: 'DELETE',
      url: '/api/web/market/alerts/abc',
      headers: mutationHeaders(mine),
    });
    expect(malformed.statusCode).toBe(404);
  });
});

describe('market alert routes: GET /api/web/market/alerts/events', () => {
  it('lists the newest 50 own events with type and region names', async () => {
    const session = browserSession();
    const other = browserSession();
    const alertId = addAlert(session.userId, {});
    const foreignAlertId = addAlert(other.userId, {});
    for (let index = 0; index < 55; index += 1) {
      db.prepare(`
        INSERT INTO market_alert_events (alert_id, user_id, type_id, price, threshold)
        VALUES (?, ?, ?, ?, ?)
      `).run(alertId, session.userId, TRITANIUM, 100 + index, 100);
    }
    db.prepare(`
      INSERT INTO market_alert_events (alert_id, user_id, type_id, price, threshold)
      VALUES (?, ?, ?, 1, 1)
    `).run(foreignAlertId, other.userId, PYERITE);
    // Mark the newest own event as delivered (event_id 55; the foreign row is 56).
    db.prepare("UPDATE market_alert_events SET delivered_at = datetime('now') WHERE event_id = 55").run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/alerts/events',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { ok: boolean; events: Array<Record<string, unknown>> };
    expect(payload.ok).toBe(true);
    expect(payload.events).toHaveLength(50);
    // Newest first, own events only.
    const ids = payload.events.map((event) => event.event_id as number);
    expect(ids).toEqual([...ids].sort((left, right) => right - left));
    expect(ids).not.toContain(56); // the foreign event is the 56th row
    expect(payload.events[0]).toMatchObject({
      alert_id: alertId,
      type_id: TRITANIUM,
      type_name: 'Tritanium',
      region_id: FORGE,
      region_name: 'The Forge',
      price: 154,
      threshold: 100,
      delivered_at: expect.any(String), // event_id 55, marked delivered above
    });
    const undelivered = payload.events.find((event) => event.event_id === 54);
    expect(undelivered?.delivered_at).toBeNull();
  });
});
