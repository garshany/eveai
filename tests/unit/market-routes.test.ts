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

const ORIGIN = 'http://localhost:3000';
const FORGE = 10000002;
const DOMAIN = 10000043;
const JITA = 30000142;
const JITA_STATION = 60003760;

const TRITANIUM = 34;
const PYERITE = 35;
const TRITANIUM_BARS = 1234;

function browserSession(): { cookie: string; csrf: string; userId: number } {
  const created = createWebSession(db);
  return {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
  };
}

function mutationHeaders(session: { cookie: string; csrf: string }) {
  return {
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
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

function insertMarketGroup(groupId: number, name: string, parentGroupId: number | null): void {
  db.prepare('INSERT INTO sde_market_groups (market_group_id, name, parent_group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(groupId, name, parentGroupId, '{}');
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

function seedTypes(): void {
  insertType(TRITANIUM, 'Tritanium', 18, { published: true, marketGroupID: 5 });
  insertType(PYERITE, 'Pyerite', 18, { published: true, marketGroupID: 5 });
  insertType(TRITANIUM_BARS, 'Tritanium Bars', 18, { published: true, marketGroupID: 5 });
}

describe('market routes', () => {
  it('rejects the snapshot status without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/market/status' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Сессия истекла. Обновите страницу.' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects the trade regions without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/market/regions' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Сессия истекла. Обновите страницу.' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports an empty snapshot meta when no sweep has run yet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/status',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      ok: true,
      snapshot: {
        loaded: false,
        status: 'idle',
        snapshot_time: null,
        age_minutes: null,
        stale: true,
        rows_loaded: null,
        last_error: null,
        regions: [],
      },
    });
  });

  it('reflects recorded region freshness in the snapshot meta', async () => {
    // recordRegionFetched stores ISO timestamps; datetime('now') would parse
    // as local time and skew the computed age.
    db.prepare(`
      INSERT INTO market_snapshot_regions (region_id, pages, rows_loaded, fetched_at, expires_at, last_error)
      VALUES (10000002, 120, 500000, ?, NULL, NULL)
    `).run(new Date().toISOString());

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/status',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      snapshot: {
        loaded: false,
        regions: [{
          region_id: 10000002,
          fetched_at: expect.any(String),
          age_minutes: expect.any(Number),
          stale: false,
          last_error: null,
        }],
      },
    });
  });

  it('lists k-space trade regions from the local SDE', async () => {
    db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (10000002, 'The Forge', '{}')").run();
    db.prepare(`
      INSERT INTO sde_constellations (constellation_id, name, region_id, data_json)
      VALUES (20000020, 'Kimotoro', 10000002, '{}')
    `).run();
    db.prepare(`
      INSERT INTO sde_systems (system_id, name, constellation_id, data_json)
      VALUES (30000142, 'Jita', 20000020, '{}')
    `).run();
    db.prepare(`
      INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json)
      VALUES (50000001, 30000142, 30000144, 50000002, '{}')
    `).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/regions',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      ok: true,
      regions: [{ region_id: 10000002, name: 'The Forge', stargates: 1 }],
    });
  });
});

describe('market search route', () => {
  it('rejects requests without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/market/search?q=Trit' });
    expect(response.statusCode).toBe(401);
  });

  it('requires a query of at least two characters', async () => {
    const cookie = browserSessionCookie();
    for (const url of ['/api/web/market/search', '/api/web/market/search?q=', '/api/web/market/search?q=a']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Поисковый запрос должен содержать минимум 2 символа.' });
    }
  });

  it('rejects an out-of-range limit', async () => {
    const cookie = browserSessionCookie();
    for (const limit of ['abc', '0', '-1', '51']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/web/market/search?q=Trit&limit=${limit}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Лимит должен быть целым числом от 1 до 50.' });
    }
  });

  it('finds tradeable types with exact and prefix matches first', async () => {
    seedTypes();
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/search?q=Tritanium',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      ok: boolean;
      results: Array<{ type_id: number; name: string; market_group_id: number | null }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.results.map((row) => row.name)).toEqual(['Tritanium', 'Tritanium Bars']);
    expect(payload.results[0]).toMatchObject({ type_id: TRITANIUM, market_group_id: 5 });
  });

  it('honours the limit parameter', async () => {
    seedTypes();
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/search?q=Tritanium&limit=1',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { results: unknown[] }).results).toHaveLength(1);
  });
});

describe('market groups routes', () => {
  it('rejects requests without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/market/groups' });
    expect(response.statusCode).toBe(401);
    const typesResponse = await app.inject({ method: 'GET', url: '/api/web/market/groups/5/types' });
    expect(typesResponse.statusCode).toBe(401);
  });

  it('rejects a malformed parent group', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/groups?parent=abc',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Некорректная маркет-группа.' });
  });

  it('lists root groups with a has_children flag and drills into a parent', async () => {
    insertMarketGroup(1, 'Minerals', null);
    insertMarketGroup(2, 'Ships', null);
    insertMarketGroup(5, 'Standard Minerals', 1);

    const root = await app.inject({
      method: 'GET',
      url: '/api/web/market/groups',
      headers: { cookie: browserSessionCookie() },
    });
    expect(root.statusCode).toBe(200);
    expect(root.json()).toEqual({
      ok: true,
      groups: [
        { market_group_id: 1, name: 'Minerals', parent_group_id: null, has_children: true },
        { market_group_id: 2, name: 'Ships', parent_group_id: null, has_children: false },
      ],
    });

    const children = await app.inject({
      method: 'GET',
      url: '/api/web/market/groups?parent=1',
      headers: { cookie: browserSessionCookie() },
    });
    expect(children.statusCode).toBe(200);
    expect(children.json()).toEqual({
      ok: true,
      groups: [
        { market_group_id: 5, name: 'Standard Minerals', parent_group_id: 1, has_children: false },
      ],
    });
  });

  it('rejects a malformed group id or limit on the types listing', async () => {
    const cookie = browserSessionCookie();
    const badGroup = await app.inject({
      method: 'GET',
      url: '/api/web/market/groups/abc/types',
      headers: { cookie },
    });
    expect(badGroup.statusCode).toBe(400);
    expect(badGroup.json()).toEqual({ error: 'Некорректная маркет-группа.' });

    for (const limit of ['abc', '0', '201']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/web/market/groups/5/types?limit=${limit}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Лимит должен быть целым числом от 1 до 200.' });
    }
  });

  it('lists the published types of a market group', async () => {
    seedTypes();
    insertType(9999, 'Unpublished Widget', 18, { published: false, marketGroupID: 5 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/groups/5/types?limit=2',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { ok: boolean; types: Array<{ type_id: number; name: string }> };
    expect(payload.ok).toBe(true);
    expect(payload.types.map((row) => row.name)).toEqual(['Pyerite', 'Tritanium']);
  });
});

describe('market watchlist routes', () => {
  it('rejects reads without a session and mutations without CSRF', async () => {
    const read = await app.inject({ method: 'GET', url: '/api/web/market/watchlist' });
    expect(read.statusCode).toBe(401);

    const session = browserSession();
    const post = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: { type_id: TRITANIUM },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json()).toEqual({ error: 'Проверка безопасности запроса не пройдена.' });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/web/market/watchlist/${TRITANIUM}`,
      headers: { origin: ORIGIN, cookie: session.cookie },
    });
    expect(del.statusCode).toBe(403);

    const noSession = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: { origin: ORIGIN },
      payload: { type_id: TRITANIUM },
    });
    expect(noSession.statusCode).toBe(401);
  });

  it('validates the body and the type against the local SDE', async () => {
    const session = browserSession();
    const missingType = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(session),
      payload: {},
    });
    expect(missingType.statusCode).toBe(400);
    expect(missingType.json()).toEqual({ error: 'Некорректный идентификатор товара.' });

    const badRegion = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(session),
      payload: { type_id: TRITANIUM, region_id: -5 },
    });
    expect(badRegion.statusCode).toBe(400);
    expect(badRegion.json()).toEqual({ error: 'Некорректный регион.' });

    seedTypes();
    const unknownType = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(session),
      payload: { type_id: 777777 },
    });
    expect(unknownType.statusCode).toBe(404);
    expect(unknownType.json()).toEqual({ error: 'Товар не найден в локальной базе.' });
  });

  it('adds, deduplicates, lists and deletes watchlist rows', async () => {
    seedTypes();
    insertOrder({ order_id: 101, is_buy_order: 0, price: 5.5 });
    insertOrder({ order_id: 102, is_buy_order: 1, price: 4.5 });
    const session = browserSession();

    const created = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(session),
      payload: { type_id: TRITANIUM },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      ok: true,
      created: true,
      item: {
        type_id: TRITANIUM,
        type_name: 'Tritanium',
        region_id: FORGE,
        best_sell: 5.5,
        best_buy: 4.5,
        created_at: expect.any(String),
      },
    });

    // The default region is stored as a concrete id, never NULL (a nullable
    // PK column would silently allow duplicates in SQLite).
    const stored = db.prepare('SELECT region_id FROM market_watchlist WHERE user_id = ? AND type_id = ?')
      .get(session.userId, TRITANIUM) as { region_id: number };
    expect(stored.region_id).toBe(FORGE);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(session),
      payload: { type_id: TRITANIUM },
    });
    expect(duplicate.statusCode).toBe(200);
    expect((duplicate.json() as { created: boolean }).created).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM market_watchlist WHERE user_id = ?')
      .get(session.userId)).toEqual({ count: 1 });

    // The same type in another region is a distinct row.
    const otherRegion = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(session),
      payload: { type_id: TRITANIUM, region_id: DOMAIN },
    });
    expect(otherRegion.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: '/api/web/market/watchlist',
      headers: { cookie: session.cookie },
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ type_id: number; region_id: number }> }).items;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.region_id).sort()).toEqual([FORGE, DOMAIN]);

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/web/market/watchlist/${PYERITE}`,
      headers: mutationHeaders(session),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Позиция не найдена в списке наблюдения.' });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/web/market/watchlist/${TRITANIUM}?region_id=${DOMAIN}`,
      headers: mutationHeaders(session),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });

    const after = await app.inject({
      method: 'GET',
      url: '/api/web/market/watchlist',
      headers: { cookie: session.cookie },
    });
    expect((after.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('keeps watchlists isolated between browser users', async () => {
    seedTypes();
    const first = browserSession();
    const second = browserSession();

    await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(first),
      payload: { type_id: TRITANIUM },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/web/market/watchlist',
      headers: { cookie: second.cookie },
    });
    expect((list.json() as { items: unknown[] }).items).toEqual([]);
  });

  it('enforces the per-user watchlist limit', async () => {
    seedTypes();
    const session = browserSession();
    const insert = db.prepare('INSERT INTO market_watchlist (user_id, type_id, region_id) VALUES (?, ?, ?)');
    for (let index = 0; index < 100; index += 1) {
      insert.run(session.userId, 1000 + index, FORGE);
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(session),
      payload: { type_id: TRITANIUM },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Список наблюдения заполнен (максимум 100 позиций).' });

    // A duplicate of an existing row stays idempotent even at the limit.
    insert.run(session.userId, TRITANIUM, DOMAIN);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/web/market/watchlist',
      headers: mutationHeaders(session),
      payload: { type_id: TRITANIUM, region_id: DOMAIN },
    });
    expect(duplicate.statusCode).toBe(200);
    expect((duplicate.json() as { created: boolean }).created).toBe(false);
  });
});

describe('market type info route', () => {
  function seedInfoType(): void {
    db.prepare("INSERT INTO sde_categories (category_id, name, data_json) VALUES (6, 'Ship', '{}')").run();
    db.prepare("INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (25, 'Frigate', 6, '{}')").run();
    db.prepare("INSERT INTO sde_market_groups (market_group_id, name, parent_group_id, data_json) VALUES (61, 'Standard Frigates', NULL, '{}')").run();
    db.prepare("INSERT INTO sde_meta_groups (meta_group_id, name, data_json) VALUES (1, 'Tech I', '{}')").run();
    insertType(TRITANIUM, 'Rifter', 25, {
      published: 1,
      marketGroupID: 61,
      metaGroupID: 1,
      description: { en: 'A frigate.', ru: 'Фрегат.' },
    });
  }

  it('rejects requests without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/market/types/34/info' });
    expect(response.statusCode).toBe(401);
  });

  it('validates the type id and lang', async () => {
    const cookie = browserSessionCookie();
    const badId = await app.inject({ method: 'GET', url: '/api/web/market/types/abc/info', headers: { cookie } });
    expect(badId.statusCode).toBe(400);
    const badLang = await app.inject({ method: 'GET', url: '/api/web/market/types/34/info?lang=de', headers: { cookie } });
    expect(badLang.statusCode).toBe(400);
    expect(badLang.json()).toEqual({ error: "Параметр lang должен быть 'en' или 'ru'." });
  });

  it('returns 404 for a type missing from the SDE', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/types/34/info',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Товар не найден в локальной базе.' });
  });

  it('serves the assembled card with static-SDE cache headers', async () => {
    seedInfoType();
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/market/types/34/info?lang=ru',
      headers: { cookie: browserSessionCookie() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, max-age=300');
    const payload = response.json() as {
      ok: boolean;
      info: { name: string; description: string | null; group_name: string | null; meta_group_name: string | null };
    };
    expect(payload.ok).toBe(true);
    expect(payload.info).toMatchObject({
      name: 'Rifter',
      description: 'Фрегат.',
      group_name: 'Frigate',
      meta_group_name: 'Tech I',
    });
  });
});

describe('market static-SDE cache headers', () => {
  it('lets the browser cache the group tree briefly, but not live data', async () => {
    const cookie = browserSessionCookie();

    const groups = await app.inject({ method: 'GET', url: '/api/web/market/groups', headers: { cookie } });
    expect(groups.statusCode).toBe(200);
    expect(groups.headers['cache-control']).toBe('private, max-age=300');

    insertMarketGroup(5, 'Standard Minerals', null);
    const types = await app.inject({ method: 'GET', url: '/api/web/market/groups/5/types', headers: { cookie } });
    expect(types.statusCode).toBe(200);
    expect(types.headers['cache-control']).toBe('private, max-age=300');

    // Живые данные (снапшот, поиск, ордера) остаются no-store.
    const status = await app.inject({ method: 'GET', url: '/api/web/market/status', headers: { cookie } });
    expect(status.headers['cache-control']).toBe('no-store');

    seedTypes();
    const search = await app.inject({ method: 'GET', url: '/api/web/market/search?q=Trit', headers: { cookie } });
    expect(search.headers['cache-control']).toBe('no-store');
  });
});
