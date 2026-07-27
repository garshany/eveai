import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { registerMarketRoutes } from '../../src/web/market-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

const FORGE = 10000002;
const DOMAIN = 10000043;
const JITA = 30000142;
const AMARR = 30002187;
const JITA_STATION = 60003760;

const TRITANIUM = 34;

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerMarketRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

function browserSessionCookie(): string {
  const created = createWebSession(db);
  return `${WEB_SESSION_COOKIE}=${created.sessionToken}`;
}

function insertType(
  typeId: number,
  name: string,
  groupId: number | null,
  data: Record<string, unknown>,
): void {
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(typeId, name, groupId, JSON.stringify(data));
}

function insertOrder(overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    order_id: 1,
    type_id: TRITANIUM,
    region_id: FORGE,
    system_id: JITA,
    station_id: JITA_STATION,
    location_id: JITA_STATION,
    is_buy_order: 0,
    price: 5.5,
    volume_remain: 1000,
    volume_total: 1000,
    min_volume: 1,
    duration: 90,
    range: 'region',
    issued: '2026-07-27T09:55:00Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, region_id, system_id, station_id, location_id,
      is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.order_id, row.type_id, row.region_id, row.system_id, row.station_id, row.location_id,
    row.is_buy_order, row.price, row.volume_remain, row.volume_total, row.min_volume,
    row.duration, row.range, row.issued,
  );
}

function seedSde(): void {
  db.prepare("INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (18, 'Mineral', 3, '{}')").run();
  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, 'The Forge', '{}')").run(FORGE);
  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, 'Domain', '{}')").run(DOMAIN);
  db.prepare("INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, 'Jita', NULL, '{}')").run(JITA);
  db.prepare("INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, 'Amarr', NULL, '{}')").run(AMARR);
  db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
    .run(JITA_STATION, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', JITA, '{}');
  insertType(TRITANIUM, 'Tritanium', 18, { published: true, marketGroupID: 5 });
}

describe('market type overview route', () => {
  it('rejects requests without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/web/market/types/${TRITANIUM}/overview?region_id=${FORGE}` });
    expect(response.statusCode).toBe(401);
  });

  it('validates the type id and the required region', async () => {
    const cookie = browserSessionCookie();
    const badType = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/abc/overview?region_id=${FORGE}`,
      headers: { cookie },
    });
    expect(badType.statusCode).toBe(400);
    expect(badType.json()).toEqual({ error: 'Некорректный идентификатор товара.' });

    const noRegion = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/overview`,
      headers: { cookie },
    });
    expect(noRegion.statusCode).toBe(400);
    expect(noRegion.json()).toEqual({ error: 'Параметр region_id обязателен.' });

    const badRegion = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/overview?region_id=abc`,
      headers: { cookie },
    });
    expect(badRegion.statusCode).toBe(400);
    expect(badRegion.json()).toEqual({ error: 'Некорректный регион.' });
  });

  it('returns 404 for a type missing from the local SDE', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/777777/overview?region_id=${FORGE}`,
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Товар не найден в локальной базе.' });
  });

  it('reports best prices, volumes and the spread for a seeded book', async () => {
    seedSde();
    insertOrder({ order_id: 1, is_buy_order: 0, price: 5.5, volume_remain: 1000 });
    insertOrder({ order_id: 2, is_buy_order: 0, price: 6.5, volume_remain: 500 });
    insertOrder({ order_id: 3, is_buy_order: 1, price: 4.5, volume_remain: 2000 });

    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/overview?region_id=${FORGE}`,
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { ok: boolean; overview: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.overview).toMatchObject({
      type_id: TRITANIUM,
      type_name: 'Tritanium',
      group_name: 'Mineral',
      region_id: FORGE,
      best_sell: 5.5,
      best_buy: 4.5,
      sell_volume: 1500,
      buy_volume: 2000,
      sell_orders: 2,
      buy_orders: 1,
      spread_abs: 1,
    });
    expect(payload.overview.spread_pct).toBeCloseTo(18.1818, 3);
  });
});

describe('market type orders route', () => {
  it('rejects requests without a browser session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/orders?region_id=${FORGE}&side=sell`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires a valid side parameter', async () => {
    const cookie = browserSessionCookie();
    for (const side of ['', 'hold']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/web/market/types/${TRITANIUM}/orders?region_id=${FORGE}&side=${side}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Параметр side должен быть 'sell' или 'buy'." });
    }
  });

  it('validates limit and offset bounds', async () => {
    const cookie = browserSessionCookie();
    const badLimit = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/orders?region_id=${FORGE}&side=sell&limit=101`,
      headers: { cookie },
    });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json()).toEqual({ error: 'Лимит должен быть целым числом от 1 до 100.' });

    const badOffset = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/orders?region_id=${FORGE}&side=sell&offset=-1`,
      headers: { cookie },
    });
    expect(badOffset.statusCode).toBe(400);
    expect(badOffset.json()).toEqual({ error: 'Смещение (offset) должно быть неотрицательным целым числом.' });
  });

  it('serves the sell side cheapest-first with pagination', async () => {
    seedSde();
    insertOrder({ order_id: 1, is_buy_order: 0, price: 5.5 });
    insertOrder({ order_id: 2, is_buy_order: 0, price: 5.4 });
    insertOrder({ order_id: 3, is_buy_order: 0, price: 5.6 });
    insertOrder({ order_id: 4, is_buy_order: 1, price: 4.5 });
    const cookie = browserSessionCookie();

    const page = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/orders?region_id=${FORGE}&side=sell&limit=2`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    const orders = (page.json() as { orders: Array<{ price: number; is_buy_order: boolean; location_name: string | null }> }).orders;
    expect(orders.map((order) => order.price)).toEqual([5.4, 5.5]);
    expect(orders[0]).toMatchObject({
      is_buy_order: false,
      location_name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
    });

    const rest = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/orders?region_id=${FORGE}&side=sell&limit=2&offset=2`,
      headers: { cookie },
    });
    expect((rest.json() as { orders: Array<{ price: number }> }).orders.map((order) => order.price)).toEqual([5.6]);

    const buys = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/orders?region_id=${FORGE}&side=buy`,
      headers: { cookie },
    });
    expect((buys.json() as { orders: Array<{ price: number }> }).orders.map((order) => order.price)).toEqual([4.5]);
  });
});

describe('market type regions route', () => {
  it('compares per-region best prices for a type', async () => {
    seedSde();
    insertOrder({ order_id: 1, region_id: FORGE, is_buy_order: 0, price: 5.5 });
    insertOrder({ order_id: 2, region_id: DOMAIN, system_id: AMARR, station_id: null, location_id: 12345, is_buy_order: 0, price: 4.9, volume_remain: 300 });
    insertOrder({ order_id: 3, region_id: DOMAIN, system_id: AMARR, station_id: null, location_id: 12345, is_buy_order: 1, price: 4.2, volume_remain: 100 });

    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/regions`,
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    const regions = (response.json() as {
      regions: Array<{ region_id: number; region_name: string | null; min_sell: number | null; max_buy: number | null }>;
    }).regions;
    // Cheapest sell sorts first.
    expect(regions).toEqual([
      { region_id: DOMAIN, region_name: 'Domain', min_sell: 4.9, max_buy: 4.2, sell_volume: 300, buy_volume: 100, sell_orders: 1, buy_orders: 1 },
      { region_id: FORGE, region_name: 'The Forge', min_sell: 5.5, max_buy: null, sell_volume: 1000, buy_volume: 0, sell_orders: 1, buy_orders: 0 },
    ]);
  });

  it('rejects a malformed type id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/types/abc/regions',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Некорректный идентификатор товара.' });
  });
});

describe('market type history route', () => {
  function seedHistory(): void {
    // The route validates the pair against the SDE before serving history.
    seedSde();
    const insert = db.prepare(`
      INSERT INTO market_price_history (region_id, type_id, date, order_count, volume, highest, average, lowest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(FORGE, TRITANIUM, '2026-07-25', 120, 5_000_000, 5.6, 5.5, 5.4);
    insert.run(FORGE, TRITANIUM, '2026-07-26', 150, 6_000_000, 5.8, 5.7, 5.5);
    // Far-future next_due_at keeps the route on local data: no ESI backfill.
    db.prepare(`
      INSERT INTO market_history_sync (region_id, type_id, last_synced_at, next_due_at, status, error)
      VALUES (?, ?, '2026-07-27T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'ok', NULL)
    `).run(FORGE, TRITANIUM);
  }

  it('rejects requests without a browser session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/history?region_id=${FORGE}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts only the documented days windows', async () => {
    const cookie = browserSessionCookie();
    for (const days of ['7', 'abc', '91']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/web/market/types/${TRITANIUM}/history?region_id=${FORGE}&days=${days}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Параметр days должен быть одним из: 30, 90, 365, 0 (вся история).' });
    }
  });

  it('serves the stored series with stats and freshness', async () => {
    seedHistory();
    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/history?region_id=${FORGE}&days=30`,
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      ok: boolean;
      history: {
        region_id: number;
        type_id: number;
        series: Array<{ date: string; average: number }>;
        stats: { mean_average: number | null; median_average: number | null };
        freshness: { status: string | null; last_synced_at: string | null; next_due_at: string | null; error: string | null };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.history.region_id).toBe(FORGE);
    expect(payload.history.type_id).toBe(TRITANIUM);
    expect(payload.history.series.map((point) => point.date)).toEqual(['2026-07-25', '2026-07-26']);
    expect(payload.history.stats.mean_average).toBeCloseTo(5.6, 6);
    expect(payload.history.stats.median_average).toBeCloseTo(5.6, 6);
    expect(payload.history.freshness).toEqual({
      status: 'ok',
      last_synced_at: '2026-07-27T00:00:00.000Z',
      next_due_at: '2999-01-01T00:00:00.000Z',
      error: null,
    });
  });

  it('treats days=0 as the full stored history', async () => {
    seedHistory();
    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/history?region_id=${FORGE}&days=0`,
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { history: { series: unknown[] } }).history.series).toHaveLength(2);
  });

  it('rejects a type missing from the SDE and never starts a sync for it', async () => {
    seedSde();
    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/99999999/history?region_id=${FORGE}`,
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Предмет не найден.' });
    const sync = db.prepare('SELECT COUNT(*) AS count FROM market_history_sync').get() as { count: number };
    expect(sync.count).toBe(0);
  });

  it('rejects a region missing from the SDE and never starts a sync for it', async () => {
    seedSde();
    const response = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${TRITANIUM}/history?region_id=99999999`,
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Неизвестный регион.' });
    const sync = db.prepare('SELECT COUNT(*) AS count FROM market_history_sync').get() as { count: number };
    expect(sync.count).toBe(0);
  });
});
