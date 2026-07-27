import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { config } from '../../src/config.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { registerProfileRoutes } from '../../src/web/profile-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';
const FORGE = 10000002;
const KIMOTORO = 20000020;
const JITA = 30000142;
const PERIMETER = 30000144;
const JITA_STATION = 60003760;
const PERIMETER_STATION = 60000001;
const JITA_STATION_2 = 60000002;
const STRUCTURE_ID = 1_000_000_000_001;

const TRITANIUM = 34;
const PYERITE = 35;
const MEXALLON = 36;
const VEXOR = 587;
const CONTAINER = 999;
const IMPLANT_SQUIRE = 1001;
const IMPLANT_KNIGHT = 1002;
const SKILL_MECHANICS = 3413;
const SKILL_GUNNERY = 3450;

const CHARACTER_A = 90000001;
const CHARACTER_B = 90000002;

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let fetchMock: ReturnType<typeof vi.fn>;

type BrowserSession = { cookie: string; csrf: string; userId: number; chatId: number };

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerProfileRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
  vi.unstubAllGlobals();
});

function browserSession(): BrowserSession {
  const created = createWebSession(db);
  return {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
    chatId: created.chatId,
  };
}

function mutationHeaders(session: BrowserSession) {
  return {
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
}

function linkCharacter(
  session: BrowserSession,
  characterId: number,
  name: string,
  scopes: string[] = [],
): void {
  db.prepare(`
    INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?)
  `).run(characterId, name, JSON.stringify(scopes), session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, characterId, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(characterId, session.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(characterId, session.chatId);
}

function insertType(typeId: number, name: string, groupId: number | null, data: Record<string, unknown>): void {
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(typeId, name, groupId, JSON.stringify(data));
}

function seedSde(): void {
  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, 'The Forge', '{}')").run(FORGE);
  db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)')
    .run(KIMOTORO, 'Kimotoro', FORGE, '{}');
  db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)')
    .run(JITA, 'Jita', KIMOTORO, '{}');
  db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)')
    .run(PERIMETER, 'Perimeter', KIMOTORO, '{}');
  db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
    .run(JITA_STATION, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', JITA, '{}');
  db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
    .run(PERIMETER_STATION, 'Perimeter - Trader\'s Hub', PERIMETER, '{}');
  db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
    .run(JITA_STATION_2, 'Jita IV - Moon 5 - Spare Parts Depot', JITA, '{}');
  db.prepare('INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (18, \'Mineral\', 1, \'{}\')').run();
  db.prepare('INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (25, \'Cruiser\', 2, \'{}\')').run();
  insertType(TRITANIUM, 'Tritanium', 18, { volume: 0.01 });
  insertType(PYERITE, 'Pyerite', 18, { volume: 0.01 });
  insertType(MEXALLON, 'Mexallon', 18, { volume: 0.01 });
  insertType(VEXOR, 'Vexor', 25, { volume: 115000 });
  insertType(CONTAINER, 'Station Container', null, { volume: 1000 });
  insertType(IMPLANT_SQUIRE, 'Squire PG8', null, {});
  insertType(IMPLANT_KNIGHT, 'Knight AC3', null, {});
  insertType(SKILL_MECHANICS, 'Mechanics', null, {});
  insertType(SKILL_GUNNERY, 'Gunnery', null, {});
}

function insertAsset(
  characterId: number,
  itemId: number,
  typeId: number,
  locationId: number,
  options: { locationType?: string; quantity?: number; isBlueprintCopy?: number } = {},
): void {
  db.prepare(`
    INSERT INTO character_assets (
      character_id, item_id, type_id, location_id, location_type, location_flag,
      quantity, is_singleton, is_blueprint_copy, data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, 'Hangar', ?, 0, ?, '{}', datetime('now'))
  `).run(
    characterId, itemId, typeId, locationId,
    options.locationType ?? 'station',
    options.quantity ?? 1,
    options.isBlueprintCopy ?? 0,
  );
}

function insertMarketSellOrder(orderId: number, typeId: number, price: number, regionId = FORGE): void {
  db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, region_id, system_id, station_id, location_id,
      is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1000, 1000, 1, 90, 'region', '2026-07-27T09:55:00Z')
  `).run(orderId, typeId, regionId, JITA, JITA_STATION, JITA_STATION, price);
}

function seedCharacterAssets(characterId: number): void {
  // Jita: two hangar stacks plus a container whose content must roll up here.
  insertAsset(characterId, 1, TRITANIUM, JITA_STATION, { quantity: 1000 });
  insertAsset(characterId, 2, PYERITE, JITA_STATION, { quantity: 500 });
  insertAsset(characterId, 10, CONTAINER, JITA_STATION, { quantity: 1 });
  insertAsset(characterId, 11, TRITANIUM, 10, { locationType: 'item', quantity: 2000, isBlueprintCopy: 1 });
  // Perimeter: a ship without regional orders plus a priced stack (partial).
  insertAsset(characterId, 3, VEXOR, PERIMETER_STATION, { quantity: 1 });
  insertAsset(characterId, 5, TRITANIUM, PERIMETER_STATION, { quantity: 100 });
  // Jita 2: only an unpriced type (unavailable despite a known region).
  insertAsset(characterId, 6, MEXALLON, JITA_STATION_2, { quantity: 10 });
  // Player structure: no resolvable region, valuation stays unavailable.
  insertAsset(characterId, 4, TRITANIUM, STRUCTURE_ID, { quantity: 100 });
}

function seedForgeSellOrders(): void {
  insertMarketSellOrder(101, TRITANIUM, 6.0);
  insertMarketSellOrder(102, TRITANIUM, 5.5);
  insertMarketSellOrder(103, PYERITE, 8.0);
  insertMarketSellOrder(104, CONTAINER, 0.5);
}

function daysAgoIso(days: number, hourOffset = 0): string {
  return new Date(Date.now() - days * 86_400_000 + hourOffset * 3_600_000).toISOString();
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3600_000).toUTCString(),
      'X-Pages': '1',
      ...headers,
    },
  });
}

describe('profile routes access', () => {
  it('rejects requests without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/profile/assets' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Сессия истекла. Обновите страницу.' });
  });

  it('returns 404 when the session has no linked character', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Персонаж не подключён.' });
  });
});

describe('profile assets routes', () => {
  it('groups assets by location with regional valuations', async () => {
    seedSde();
    seedForgeSellOrders();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    seedCharacterAssets(CHARACTER_A);

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      total: number;
      limit: number;
      offset: number;
      locations: Array<Record<string, unknown>>;
    };
    expect(payload.total).toBe(4);
    expect(payload.limit).toBe(50);
    expect(payload.offset).toBe(0);

    const byLocation = new Map(payload.locations.map((row) => [row.locationId as number, row]));

    // Jita: the container content (2000 trit) rolls up to the station root;
    // the BPC stack is excluded from the valuation basis (a copy is not worth
    // the original's sell price), the rest is priced.
    expect(byLocation.get(JITA_STATION)).toMatchObject({
      kind: 'station',
      name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
      solarSystemName: 'Jita',
      regionId: FORGE,
      regionName: 'The Forge',
      itemCount: 4,
      totalQuantity: 3501,
      valuation: 'complete',
      // 1000 * 5.5 + 500 * 8.0 + 1 * 0.5 (the container itself); BPC excluded.
      estimatedValue: 9500.5,
    });

    // Perimeter: trit is priced, the Vexor is not.
    expect(byLocation.get(PERIMETER_STATION)).toMatchObject({
      kind: 'station',
      itemCount: 2,
      valuation: 'partial',
      estimatedValue: 550,
    });

    // Jita 2: known region but no orders at all.
    expect(byLocation.get(JITA_STATION_2)).toMatchObject({
      kind: 'station',
      estimatedValue: null,
      valuation: 'unavailable',
    });

    // Structure: no invented server-side label — name is null, the kind goes
    // out and the client localizes the caption; no region, no valuation.
    expect(byLocation.get(STRUCTURE_ID)).toMatchObject({
      kind: 'structure',
      name: null,
      solarSystemName: null,
      regionId: null,
      regionName: null,
      estimatedValue: null,
      valuation: 'unavailable',
    });

    // Sorted by estimated value desc, nulls last.
    expect(payload.locations.map((row) => row.locationId)).toEqual([
      JITA_STATION, PERIMETER_STATION, JITA_STATION_2, STRUCTURE_ID,
    ]);
  });

  it('paginates locations', async () => {
    seedSde();
    seedForgeSellOrders();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    seedCharacterAssets(CHARACTER_A);

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets?limit=1&offset=1',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { total: number; locations: Array<{ locationId: number }> };
    expect(payload.total).toBe(4);
    expect(payload.locations).toHaveLength(1);
    expect(payload.locations[0]?.locationId).toBe(PERIMETER_STATION);

    const bad = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets?limit=101',
      headers: { cookie: session.cookie },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('lists location items sorted by value with SQL pagination', async () => {
    seedSde();
    seedForgeSellOrders();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    seedCharacterAssets(CHARACTER_A);

    const first = await app.inject({
      method: 'GET',
      url: `/api/web/profile/assets/items?location_id=${JITA_STATION}&limit=2`,
      headers: { cookie: session.cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json() as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(firstPage.total).toBe(4);
    expect(firstPage.items.map((row) => row.itemId)).toEqual([1, 2]);
    // The container content is visible under the station, but as a blueprint
    // copy it is priced null (a copy is not worth the original's sell price)
    // and sinks past the priced rows.
    expect(firstPage.items[0]).toMatchObject({
      itemId: 1,
      typeId: TRITANIUM,
      typeName: 'Tritanium',
      groupName: 'Mineral',
      quantity: 1000,
      unitVolume: 0.01,
      totalVolume: 10,
      unitPrice: 5.5,
      totalValue: 5500,
      isBlueprintCopy: false,
    });

    const second = await app.inject({
      method: 'GET',
      url: `/api/web/profile/assets/items?location_id=${JITA_STATION}&limit=2&offset=2`,
      headers: { cookie: session.cookie },
    });
    const secondPage = second.json() as { items: Array<Record<string, unknown>> };
    expect(secondPage.items.map((row) => row.itemId)).toEqual([10, 11]);
    expect(secondPage.items[1]).toMatchObject({
      itemId: 11,
      typeId: TRITANIUM,
      quantity: 2000,
      unitPrice: null,
      totalValue: null,
      isBlueprintCopy: true,
    });

    // Perimeter: the unpriced Vexor sorts after the priced trit with null pricing.
    const perimeter = await app.inject({
      method: 'GET',
      url: `/api/web/profile/assets/items?location_id=${PERIMETER_STATION}`,
      headers: { cookie: session.cookie },
    });
    const perimeterItems = (perimeter.json() as { items: Array<Record<string, unknown>> }).items;
    expect(perimeterItems.map((row) => row.itemId)).toEqual([5, 3]);
    expect(perimeterItems[1]).toMatchObject({
      itemId: 3,
      typeId: VEXOR,
      unitPrice: null,
      totalValue: null,
    });
  });

  it('requires a valid location_id and returns an empty list for unknown locations', async () => {
    seedSde();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    seedCharacterAssets(CHARACTER_A);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets/items',
      headers: { cookie: session.cookie },
    });
    expect(missing.statusCode).toBe(400);

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets/items?location_id=abc',
      headers: { cookie: session.cookie },
    });
    expect(malformed.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets/items?location_id=123456789',
      headers: { cookie: session.cookie },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toMatchObject({ items: [], total: 0 });
  });

  it('keeps assets isolated between users', async () => {
    seedSde();
    seedForgeSellOrders();
    const first = browserSession();
    const second = browserSession();
    linkCharacter(first, CHARACTER_A, 'Pilot A');
    linkCharacter(second, CHARACTER_B, 'Pilot B');
    seedCharacterAssets(CHARACTER_A);
    insertAsset(CHARACTER_B, 100, MEXALLON, JITA_STATION, { quantity: 7 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: second.cookie },
    });
    const payload = response.json() as { total: number; locations: Array<{ itemCount: number }> };
    expect(payload.total).toBe(1);
    expect(payload.locations[0]?.itemCount).toBe(1);
  });
});

describe('profile orders route', () => {
  it('lists orders with names and computes totals', async () => {
    seedSde();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    const insert = db.prepare(`
      INSERT INTO character_orders (
        character_id, order_id, type_id, region_id, location_id, price,
        volume_total, volume_remain, min_volume, is_buy_order, range, duration,
        issued, escrow, data_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'region', 90, ?, ?, '{}', datetime('now'))
    `);
    insert.run(CHARACTER_A, 1, TRITANIUM, FORGE, JITA_STATION, 5.5, 2000, 1000, 0, '2026-07-20T10:00:00Z', null);
    insert.run(CHARACTER_A, 2, PYERITE, FORGE, STRUCTURE_ID, 7.5, 500, 500, 1, '2026-07-21T10:00:00Z', 3750);

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/orders',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      total: number;
      totals: Record<string, number>;
      orders: Array<Record<string, unknown>>;
    };
    expect(payload.total).toBe(2);
    expect(payload.totals).toEqual({
      sellCount: 1,
      sellTotal: 5500,
      buyCount: 1,
      buyTotal: 3750,
      escrowTotal: 3750,
    });
    // issued desc: the newer buy order first; the structure carries kind
    // 'structure' and a null name (the client localizes the caption).
    expect(payload.orders.map((row) => row.orderId)).toEqual([2, 1]);
    expect(payload.orders[0]).toMatchObject({
      orderId: 2,
      typeId: PYERITE,
      typeName: 'Pyerite',
      regionId: FORGE,
      regionName: 'The Forge',
      locationId: STRUCTURE_ID,
      locationKind: 'structure',
      locationName: null,
      isBuyOrder: true,
      price: 7.5,
      volumeRemain: 500,
      volumeTotal: 500,
      issued: '2026-07-21T10:00:00Z',
    });
    expect(payload.orders[1]).toMatchObject({
      orderId: 1,
      locationKind: 'station',
      locationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
      isBuyOrder: false,
    });

    const page = await app.inject({
      method: 'GET',
      url: '/api/web/profile/orders?limit=1&offset=1',
      headers: { cookie: session.cookie },
    });
    const paged = page.json() as { total: number; orders: Array<{ orderId: number }> };
    expect(paged.total).toBe(2);
    expect(paged.orders.map((row) => row.orderId)).toEqual([1]);
  });

  it('keeps orders isolated between users', async () => {
    seedSde();
    const first = browserSession();
    const second = browserSession();
    linkCharacter(first, CHARACTER_A, 'Pilot A');
    linkCharacter(second, CHARACTER_B, 'Pilot B');
    db.prepare(`
      INSERT INTO character_orders (
        character_id, order_id, type_id, region_id, location_id, price,
        volume_total, volume_remain, min_volume, is_buy_order, range, duration,
        issued, escrow, data_json, synced_at
      ) VALUES (?, 1, ?, ?, ?, 5.5, 10, 10, 1, 0, 'region', 90, '2026-07-20T10:00:00Z', NULL, '{}', datetime('now'))
    `).run(CHARACTER_A, TRITANIUM, FORGE, JITA_STATION);

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/orders',
      headers: { cookie: second.cookie },
    });
    expect(response.json()).toMatchObject({
      total: 0,
      orders: [],
      totals: { sellCount: 0, sellTotal: 0, buyCount: 0, buyTotal: 0, escrowTotal: 0 },
    });
  });
});

describe('profile wallet route', () => {
  it('returns the balance and a 30-day daily journal', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    db.prepare('INSERT INTO character_wallet (character_id, balance, synced_at) VALUES (?, 123456.78, datetime(\'now\'))')
      .run(CHARACTER_A);
    const insert = db.prepare(`
      INSERT INTO character_wallet_journal (
        character_id, journal_id, date, ref_type, amount, balance, data_json, synced_at
      ) VALUES (?, ?, ?, 'player_donation', ?, ?, '{}', datetime('now'))
    `);
    // Two entries on the same day: delta sums, balance is the day's last one.
    insert.run(CHARACTER_A, 1, daysAgoIso(1), -10, 90);
    insert.run(CHARACTER_A, 2, daysAgoIso(1, 1), 50, 140);
    insert.run(CHARACTER_A, 3, daysAgoIso(2), 25, 100);
    // Older than the 30-day window: excluded.
    insert.run(CHARACTER_A, 4, daysAgoIso(40), 999, 9999);

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/wallet',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      balance: number;
      journal: Array<{ date: string; delta: number; balance: number }>;
      freshness: unknown;
    };
    expect(payload.balance).toBe(123456.78);
    expect(payload.journal).toHaveLength(2);
    expect(payload.journal[0]).toMatchObject({ delta: 25, balance: 100 });
    expect(payload.journal[1]).toMatchObject({ delta: 40, balance: 140 });
    expect(payload.journal[0]!.date < payload.journal[1]!.date).toBe(true);
    expect(Array.isArray(payload.freshness)).toBe(true);
  });

  it('returns an empty journal and null balance without wallet rows', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/wallet',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ balance: null, journal: [] });
  });
});

describe('profile clones and skills routes', () => {
  it('maps clones, implants and the home location', async () => {
    seedSde();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    db.prepare(`
      INSERT INTO character_clones (character_id, jump_clone_id, location_id, location_type, name, implants_json, data_json, synced_at)
      VALUES (?, ?, ?, 'station', ?, ?, '{}', datetime('now'))
    `).run(CHARACTER_A, 5, JITA_STATION, 'Alpha Clone', JSON.stringify([IMPLANT_SQUIRE]));
    db.prepare(`
      INSERT INTO character_clones (character_id, jump_clone_id, location_id, location_type, name, implants_json, data_json, synced_at)
      VALUES (?, ?, ?, 'structure', NULL, '[]', '{}', datetime('now'))
    `).run(CHARACTER_A, 6, STRUCTURE_ID);
    db.prepare(`
      INSERT INTO character_profile (
        character_id, character_name, total_skill_points, unallocated_skill_points,
        implants_json, home_location_json, synced_at
      ) VALUES (?, 'Pilot A', 50000000, 250000, ?, ?, datetime('now'))
    `).run(
      CHARACTER_A,
      JSON.stringify([IMPLANT_SQUIRE, IMPLANT_KNIGHT]),
      JSON.stringify({ location_id: JITA_STATION, location_type: 'station' }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/clones',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      home: {
        locationId: JITA_STATION,
        locationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
      },
      jumpClones: [
        {
          jumpCloneId: 5,
          name: 'Alpha Clone',
          locationId: JITA_STATION,
          locationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
          implants: [{ typeId: IMPLANT_SQUIRE, typeName: 'Squire PG8' }],
        },
        {
          jumpCloneId: 6,
          name: null,
          locationId: STRUCTURE_ID,
          locationName: null,
          implants: [],
        },
      ],
      currentImplants: [
        { typeId: IMPLANT_SQUIRE, typeName: 'Squire PG8' },
        { typeId: IMPLANT_KNIGHT, typeName: 'Knight AC3' },
      ],
    });
  });

  it('returns the skill point totals and the training queue', async () => {
    seedSde();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    db.prepare(`
      INSERT INTO character_profile (
        character_id, character_name, total_skill_points, unallocated_skill_points,
        implants_json, home_location_json, synced_at
      ) VALUES (?, 'Pilot A', 50000000, 250000, '[]', NULL, datetime('now'))
    `).run(CHARACTER_A);
    const insert = db.prepare(`
      INSERT INTO character_skillqueue (
        character_id, queue_position, skill_id, finished_level, start_date, finish_date, data_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', datetime('now'))
    `);
    insert.run(CHARACTER_A, 2, SKILL_GUNNERY, 4, '2026-07-28T00:00:00Z', '2026-07-30T00:00:00Z');
    insert.run(CHARACTER_A, 1, SKILL_MECHANICS, 5, '2026-07-27T00:00:00Z', '2026-07-28T00:00:00Z');

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/skills',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      totalSp: number;
      unallocatedSp: number;
      queue: Array<Record<string, unknown>>;
      freshness: unknown;
    };
    expect(payload.totalSp).toBe(50000000);
    expect(payload.unallocatedSp).toBe(250000);
    expect(payload.queue.map((row) => row.queuePosition)).toEqual([1, 2]);
    expect(payload.queue[0]).toMatchObject({
      skillId: SKILL_MECHANICS,
      skillName: 'Mechanics',
      finishedLevel: 5,
      startDate: '2026-07-27T00:00:00Z',
      finishDate: '2026-07-28T00:00:00Z',
    });
    expect(Array.isArray(payload.freshness)).toBe(true);
  });
});

describe('profile access route', () => {
  it('reports granted groups and dataset requirements', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A', [
      'esi-assets.read_assets.v1',
      'esi-wallet.read_character_wallet.v1',
    ]);
    db.prepare(`
      INSERT INTO character_sync_state (character_id, dataset, status, rows_synced, synced_at, expires_at)
      VALUES (?, 'assets', 'ok', 12, '2026-01-02 03:04:05', '2026-01-02 04:04:05')
    `).run(CHARACTER_A);

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/access',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      freshness: null;
      scopes: string[];
      groups: Array<{ id: string; label: string; granted: string[]; missing: string[] }>;
      datasets: Array<Record<string, unknown>>;
    };
    expect(payload.freshness).toBeNull();
    expect(payload.scopes).toEqual(['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1']);
    const economy = payload.groups.find((group) => group.id === 'economy');
    expect(economy?.granted).toContain('esi-assets.read_assets.v1');
    expect(economy?.missing).toContain('esi-markets.read_character_orders.v1');
    const assets = payload.datasets.find((dataset) => dataset.dataset === 'assets');
    expect(assets).toMatchObject({
      status: 'ok',
      syncedAt: '2026-01-02 03:04:05',
      expiresAt: '2026-01-02 04:04:05',
      error: null,
      requiredScopes: ['esi-assets.read_assets.v1'],
    });
  });
});

describe('profile freshness', () => {
  it('reflects character_sync_state for the matching dataset', async () => {
    seedSde();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    seedCharacterAssets(CHARACTER_A);
    db.prepare(`
      INSERT INTO character_sync_state (character_id, dataset, status, rows_synced, synced_at, expires_at, error)
      VALUES (?, 'assets', 'ok', 8, '2026-01-02 03:04:05', '2026-01-02 04:04:05', NULL)
    `).run(CHARACTER_A);

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: session.cookie },
    });
    expect(response.json()).toMatchObject({
      freshness: {
        dataset: 'assets',
        status: 'ok',
        syncedAt: '2026-01-02 03:04:05',
        expiresAt: '2026-01-02 04:04:05',
        error: null,
      },
    });
  });
});

describe('profile sync route', () => {
  it('rejects mutations without CSRF', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/profile/sync',
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Проверка безопасности запроса не пройдена.' });
  });

  it('rejects unknown dataset ids', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/profile/sync',
      headers: mutationHeaders(session),
      payload: { datasets: ['assets', 'not_a_dataset'] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Неизвестный набор данных: not_a_dataset.' });
  });

  it('refreshes due datasets for the active character only', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A', ['esi-assets.read_assets.v1']);
    fetchMock.mockResolvedValue(jsonResponse([
      {
        item_id: 42,
        type_id: TRITANIUM,
        location_id: JITA_STATION,
        location_type: 'station',
        location_flag: 'Hangar',
        quantity: 5,
        is_singleton: false,
      },
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/profile/sync',
      headers: mutationHeaders(session),
      payload: { datasets: ['assets'] },
    });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      statuses: [expect.objectContaining({ dataset: 'assets', status: 'ok', rowsSynced: 1 })],
    });
    // The materialized rows belong to the session's active character.
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM character_assets WHERE character_id = ?').get(CHARACTER_A),
    ).toEqual({ count: 1 });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM character_assets WHERE character_id != ?').get(CHARACTER_A),
    ).toEqual({ count: 0 });
  });

  it('skips datasets synced less than a minute ago', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A', ['esi-assets.read_assets.v1']);
    db.prepare(`
      INSERT INTO character_sync_state (character_id, dataset, status, rows_synced, synced_at, expires_at)
      VALUES (?, 'assets', 'ok', 3, datetime('now'), datetime('now', '+1 hour'))
    `).run(CHARACTER_A);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/profile/sync',
      headers: mutationHeaders(session),
      payload: { datasets: ['assets'] },
    });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      statuses: [expect.objectContaining({ dataset: 'assets', status: 'ok', rowsSynced: 3 })],
    });
  });

  it('respects the error backoff instead of refetching a failed dataset', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A', ['esi-assets.read_assets.v1']);
    db.prepare(`
      INSERT INTO character_sync_state (character_id, dataset, status, rows_synced, synced_at, expires_at, error)
      VALUES (?, 'assets', 'error', 0, NULL, datetime('now', '+5 minutes'), 'ESI 500: boom')
    `).run(CHARACTER_A);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/profile/sync',
      headers: mutationHeaders(session),
      payload: { datasets: ['assets'] },
    });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      statuses: [expect.objectContaining({ dataset: 'assets', status: 'error' })],
    });
  });

  it('refetches a failed dataset once its error backoff elapsed', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A', ['esi-assets.read_assets.v1']);
    db.prepare(`
      INSERT INTO character_sync_state (character_id, dataset, status, rows_synced, synced_at, expires_at, error)
      VALUES (?, 'assets', 'error', 0, NULL, datetime('now', '-1 minute'), 'ESI 500: boom')
    `).run(CHARACTER_A);
    fetchMock.mockResolvedValue(jsonResponse([]));

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/profile/sync',
      headers: mutationHeaders(session),
      payload: { datasets: ['assets'] },
    });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('aborts a stuck sync at the deadline and answers 503 with Retry-After', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A', ['esi-assets.read_assets.v1']);
    const originalTimeout = config.web.profileSyncTimeoutMs;
    config.web.profileSyncTimeoutMs = 100;
    // An ESI fetcher that never answers on its own; only the deadline's abort
    // releases it.
    fetchMock.mockImplementation(
      (_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      }),
    );
    try {
      const startedAt = Date.now();
      const response = await app.inject({
        method: 'POST',
        url: '/api/web/profile/sync',
        headers: mutationHeaders(session),
        payload: { datasets: ['assets'] },
      });
      expect(Date.now() - startedAt).toBeLessThan(30_000);
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('60');
      const payload = response.json() as { error: string; statuses: Array<Record<string, unknown>> };
      expect(payload.error).toContain('не уложилась');
      expect(payload.statuses).toHaveLength(1);
      expect(payload.statuses[0]).toMatchObject({ dataset: 'assets' });
      // The sync was really stopped: the dataset is not 'ok'.
      expect(payload.statuses[0]?.status).not.toBe('ok');
    } finally {
      config.web.profileSyncTimeoutMs = originalTimeout;
    }
  });
});

describe('profile routes hardening', () => {
  it('answers a 40k-item hangar without blowing the SQLite variable limit', async () => {
    seedSde();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    const insert = db.prepare(`
      INSERT INTO character_assets (
        character_id, item_id, type_id, location_id, location_type, location_flag,
        quantity, is_singleton, is_blueprint_copy, data_json, synced_at
      ) VALUES (?, ?, ?, ?, 'station', 'Hangar', 1, 0, 0, '{}', datetime('now'))
    `);
    db.transaction(() => {
      for (let itemId = 1; itemId <= 40_000; itemId += 1) {
        insert.run(CHARACTER_A, itemId, TRITANIUM, JITA_STATION);
      }
    })();

    const response = await app.inject({
      method: 'GET',
      url: `/api/web/profile/assets/items?location_id=${JITA_STATION}`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { total: number; items: unknown[] };
    expect(payload.total).toBe(40_000);
    expect(payload.items).toHaveLength(50);

    // The locations rollup aggregates the same hangar in SQL too.
    const locations = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: session.cookie },
    });
    expect(locations.statusCode).toBe(200);
    expect(locations.json()).toMatchObject({
      total: 1,
      locations: [expect.objectContaining({ locationId: JITA_STATION, itemCount: 40_000 })],
    });
  });

  it('resolves assets in space via the solar system and values them by region', async () => {
    seedSde();
    seedForgeSellOrders();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    // A ship floating in Jita space: the location id IS the system id.
    insertAsset(CHARACTER_A, 1, TRITANIUM, JITA, { locationType: 'solar_system', quantity: 100 });
    // An id that matches nothing: honest unknowns, no invented label.
    insertAsset(CHARACTER_A, 2, TRITANIUM, 123456789, { locationType: 'other', quantity: 5 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { locations: Array<Record<string, unknown>> };
    const byLocation = new Map(payload.locations.map((row) => [row.locationId as number, row]));

    expect(byLocation.get(JITA)).toMatchObject({
      kind: 'other',
      name: null,
      solarSystemName: 'Jita',
      regionId: FORGE,
      regionName: 'The Forge',
      valuation: 'complete',
      estimatedValue: 550,
    });
    expect(byLocation.get(123456789)).toMatchObject({
      kind: 'other',
      name: null,
      solarSystemName: null,
      regionId: null,
      regionName: null,
      estimatedValue: null,
      valuation: 'unavailable',
    });

    // Items under the space location price through the system's region.
    const items = await app.inject({
      method: 'GET',
      url: `/api/web/profile/assets/items?location_id=${JITA}`,
      headers: { cookie: session.cookie },
    });
    expect(items.statusCode).toBe(200);
    expect((items.json() as { items: Array<Record<string, unknown>> }).items[0])
      .toMatchObject({ itemId: 1, unitPrice: 5.5, totalValue: 550 });
  });

  it('reports the price book age alongside the assets valuation', async () => {
    seedSde();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    insertAsset(CHARACTER_A, 1, TRITANIUM, JITA_STATION, { quantity: 1 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      priceBook: { loaded: boolean; snapshotTime: string | null; ageMinutes: number | null; stale: boolean };
    };
    // No snapshot loaded: honestly reported as absent and stale.
    expect(payload.priceBook).toEqual({
      loaded: false,
      snapshotTime: null,
      ageMinutes: null,
      stale: true,
    });
  });

  it('serves profile APIs with Cache-Control: no-store', async () => {
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('collapses raw ESI error bodies to the bare status', async () => {
    seedSde();
    const session = browserSession();
    linkCharacter(session, CHARACTER_A, 'Pilot A');
    insertAsset(CHARACTER_A, 1, TRITANIUM, JITA_STATION, { quantity: 1 });
    db.prepare(`
      INSERT INTO character_sync_state (character_id, dataset, status, rows_synced, synced_at, expires_at, error)
      VALUES (?, 'assets', 'error', 0, NULL, datetime('now', '+5 minutes'), ?)
    `).run(CHARACTER_A, 'ESI 500: {"error":"Internal server error","trace":"secret"}');

    const assets = await app.inject({
      method: 'GET',
      url: '/api/web/profile/assets',
      headers: { cookie: session.cookie },
    });
    expect(assets.json()).toMatchObject({
      freshness: { dataset: 'assets', status: 'error', error: 'ESI недоступен (500)' },
    });

    const access = await app.inject({
      method: 'GET',
      url: '/api/web/profile/access',
      headers: { cookie: session.cookie },
    });
    const payload = access.json() as { datasets: Array<{ dataset: string; error: string | null }> };
    expect(payload.datasets.find((dataset) => dataset.dataset === 'assets')?.error)
      .toBe('ESI недоступен (500)');
  });
});
