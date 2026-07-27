import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { getTypeHistory } from '../eve/market-history.js';
import {
  getMarketGroupTree,
  getMarketGroupTypes,
  getRegionalComparison,
  getTypeOrders,
  getTypeOverview,
  searchMarketTypes,
  type MarketOrderSide,
} from '../eve/market-queries.js';
import { getMarketTypeInfo } from '../eve/market-type-info.js';
import { getMarketSnapshotMeta } from '../eve/market-snapshot-loader.js';
import { loadTradeRegions } from '../eve/market-wide-summary.js';
import { cleanExpiredWebSessions } from './web-session.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';

/**
 * Market HTTP API served from the local whole-market snapshot (market_orders)
 * and the SDE. Everything sits under /api/web/market/ behind a browser
 * session; watchlist mutations additionally require the CSRF/origin check of
 * requireMutationSession. The only route that can reach ESI is the history
 * endpoint: a first view of a (region, type) pair backfills
 * market_price_history once, repeat views are pure SQLite.
 */
export function registerMarketRoutes(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/web/market/')) {
      void cleanExpiredWebSessions(db);
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.get('/api/web/market/status', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    // Tier-aware freshness: a region is stale past its own refresh interval
    // plus the tolerance, not past a flat age cutoff (a healthy minor region
    // legitimately lives up to minorIntervalMinutes).
    return {
      ok: true,
      snapshot: getMarketSnapshotMeta(db, {
        staleMinutes: config.marketSnapshot.staleMinutes,
        majorMinPages: config.marketSnapshot.majorMinPages,
        majorIntervalMinutes: config.marketSnapshot.majorIntervalMinutes,
        minorIntervalMinutes: config.marketSnapshot.minorIntervalMinutes,
      }),
    };
  });

  app.get('/api/web/market/regions', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    return { ok: true, regions: loadTradeRegions(db) };
  });

  app.get<{ Querystring: SearchQuery }>('/api/web/market/search', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const q = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (q.length < SEARCH_MIN_QUERY_LENGTH) {
      return reply.status(400).send({ error: 'Поисковый запрос должен содержать минимум 2 символа.' });
    }
    const limit = parseOptionalBoundedInteger(request.query.limit, 1, SEARCH_MAX_LIMIT);
    if (limit === null) {
      return reply.status(400).send({ error: `Лимит должен быть целым числом от 1 до ${SEARCH_MAX_LIMIT}.` });
    }
    return { ok: true, results: searchMarketTypes(db, q, limit ?? SEARCH_DEFAULT_LIMIT) };
  });

  app.get<{ Querystring: GroupsQuery }>('/api/web/market/groups', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const parent = parseOptionalBoundedInteger(request.query.parent, 1, Number.MAX_SAFE_INTEGER);
    if (parent === null) {
      return reply.status(400).send({ error: 'Некорректная маркет-группа.' });
    }
    markStaticSde(reply);
    return { ok: true, groups: getMarketGroupTree(db, parent ?? null) };
  });
  app.get<{ Params: GroupParams; Querystring: LimitQuery }>('/api/web/market/groups/:groupId/types', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const groupId = parsePositiveInteger(request.params.groupId);
    if (!groupId) {
      return reply.status(400).send({ error: 'Некорректная маркет-группа.' });
    }
    const limit = parseOptionalBoundedInteger(request.query.limit, 1, GROUP_TYPES_MAX_LIMIT);
    if (limit === null) {
      return reply.status(400).send({ error: `Лимит должен быть целым числом от 1 до ${GROUP_TYPES_MAX_LIMIT}.` });
    }
    markStaticSde(reply);
    return { ok: true, types: getMarketGroupTypes(db, groupId, limit ?? GROUP_TYPES_DEFAULT_LIMIT) };
  });

  app.get<{ Params: TypeParams; Querystring: RegionQuery }>('/api/web/market/types/:typeId/overview', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const typeId = parsePositiveInteger(request.params.typeId);
    if (!typeId) {
      return reply.status(400).send({ error: 'Некорректный идентификатор товара.' });
    }
    const regionId = parseRequiredRegionId(request.query.region_id, reply);
    if (regionId === null) return;
    const overview = getTypeOverview(db, typeId, regionId);
    if (!overview) {
      return reply.status(404).send({ error: 'Товар не найден в локальной базе.' });
    }
    return { ok: true, overview };
  });

  app.get<{ Params: TypeParams; Querystring: OrdersQuery }>('/api/web/market/types/:typeId/orders', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const typeId = parsePositiveInteger(request.params.typeId);
    if (!typeId) {
      return reply.status(400).send({ error: 'Некорректный идентификатор товара.' });
    }
    const regionId = parseRequiredRegionId(request.query.region_id, reply);
    if (regionId === null) return;
    const sideRaw = request.query.side;
    if (sideRaw !== 'sell' && sideRaw !== 'buy') {
      return reply.status(400).send({ error: "Параметр side должен быть 'sell' или 'buy'." });
    }
    const side: MarketOrderSide = sideRaw;
    const limit = parseOptionalBoundedInteger(request.query.limit, 1, ORDERS_MAX_LIMIT);
    if (limit === null) {
      return reply.status(400).send({ error: `Лимит должен быть целым числом от 1 до ${ORDERS_MAX_LIMIT}.` });
    }
    const offset = parseOptionalBoundedInteger(request.query.offset, 0, Number.MAX_SAFE_INTEGER);
    if (offset === null) {
      return reply.status(400).send({ error: 'Смещение (offset) должно быть неотрицательным целым числом.' });
    }
    return {
      ok: true,
      orders: getTypeOrders(db, {
        typeId,
        regionId,
        side,
        limit: limit ?? ORDERS_DEFAULT_LIMIT,
        offset: offset ?? 0,
      }),
    };
  });

  app.get<{ Params: TypeParams; Querystring: InfoQuery }>('/api/web/market/types/:typeId/info', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const typeId = parsePositiveInteger(request.params.typeId);
    if (!typeId) {
      return reply.status(400).send({ error: 'Некорректный идентификатор товара.' });
    }
    const langRaw = request.query.lang;
    if (langRaw !== undefined && langRaw !== 'en' && langRaw !== 'ru') {
      return reply.status(400).send({ error: "Параметр lang должен быть 'en' или 'ru'." });
    }
    const info = getMarketTypeInfo(db, typeId, langRaw ?? 'en');
    if (!info) {
      return reply.status(404).send({ error: 'Товар не найден в локальной базе.' });
    }
    markStaticSde(reply);
    return { ok: true, info };
  });

  app.get<{ Params: TypeParams }>('/api/web/market/types/:typeId/regions', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const typeId = parsePositiveInteger(request.params.typeId);
    if (!typeId) {
      return reply.status(400).send({ error: 'Некорректный идентификатор товара.' });
    }
    return { ok: true, regions: getRegionalComparison(db, typeId) };
  });

  app.get<{ Params: TypeParams; Querystring: HistoryQuery }>('/api/web/market/types/:typeId/history', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const typeId = parsePositiveInteger(request.params.typeId);
    if (!typeId) {
      return reply.status(400).send({ error: 'Некорректный идентификатор товара.' });
    }
    const regionId = parseRequiredRegionId(request.query.region_id, reply);
    if (regionId === null) return;
    let days = HISTORY_DEFAULT_DAYS;
    const daysRaw = request.query.days;
    if (daysRaw !== undefined && daysRaw !== '') {
      if (!/^\d+$/.test(daysRaw) || !HISTORY_ALLOWED_DAYS.has(Number(daysRaw))) {
        return reply.status(400).send({ error: 'Параметр days должен быть одним из: 30, 90, 365, 0 (вся история).' });
      }
      days = Number(daysRaw);
    }
    // Existence checks before getTypeHistory: a first view backfills and
    // records the pair in market_history_sync, so a garbage (region, type)
    // pair would otherwise retry in the hourly worker forever, burning ESI
    // error budget.
    const typeExists = db.prepare('SELECT 1 FROM sde_types WHERE type_id = ?').get(typeId);
    if (!typeExists) {
      return reply.status(404).send({ error: 'Предмет не найден.' });
    }
    const regionExists = db.prepare('SELECT 1 FROM sde_regions WHERE region_id = ?').get(regionId);
    if (!regionExists) {
      return reply.status(400).send({ error: 'Неизвестный регион.' });
    }
    const history = await getTypeHistory(db, regionId, typeId, { days: days === 0 ? null : days });
    return { ok: true, history };
  });

  app.get('/api/web/market/watchlist', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    return { ok: true, items: readWatchlistItems(db, session.userId) };
  });

  app.post('/api/web/market/watchlist', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Некорректное тело запроса.' });
    }
    const { type_id: typeIdRaw, region_id: regionIdRaw } = body as Record<string, unknown>;
    const typeId = parseBodyPositiveInteger(typeIdRaw);
    if (!typeId) {
      return reply.status(400).send({ error: 'Некорректный идентификатор товара.' });
    }
    // region_id is always stored as a concrete value: the (user_id, type_id,
    // region_id) primary key treats NULL as distinct, so a nullable region
    // would let duplicates through.
    let regionId = config.market.defaultRegionId;
    if (regionIdRaw !== undefined && regionIdRaw !== null && regionIdRaw !== '') {
      const parsed = parseBodyPositiveInteger(regionIdRaw);
      if (!parsed) {
        return reply.status(400).send({ error: 'Некорректный регион.' });
      }
      regionId = parsed;
    }
    const typeExists = db.prepare('SELECT 1 FROM sde_types WHERE type_id = ?').get(typeId);
    if (!typeExists) {
      return reply.status(404).send({ error: 'Товар не найден в локальной базе.' });
    }

    const existing = readWatchlistItem(db, session.userId, typeId, regionId);
    if (existing) {
      return { ok: true, created: false, item: existing };
    }
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM market_watchlist WHERE user_id = ?')
      .get(session.userId) as { count: number };
    if (count >= WATCHLIST_MAX_ITEMS) {
      return reply.status(409).send({ error: `Список наблюдения заполнен (максимум ${WATCHLIST_MAX_ITEMS} позиций).` });
    }
    db.prepare(`
      INSERT INTO market_watchlist (user_id, type_id, region_id)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id, type_id, region_id) DO NOTHING
    `).run(session.userId, typeId, regionId);
    const item = readWatchlistItem(db, session.userId, typeId, regionId);
    return reply.status(201).send({ ok: true, created: true, item });
  });

  app.delete<{ Params: TypeParams; Querystring: RegionQuery }>('/api/web/market/watchlist/:typeId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const typeId = parsePositiveInteger(request.params.typeId);
    if (!typeId) {
      return reply.status(400).send({ error: 'Некорректный идентификатор товара.' });
    }
    let regionId = config.market.defaultRegionId;
    const regionRaw = request.query.region_id;
    if (regionRaw !== undefined && regionRaw !== '') {
      const parsed = parsePositiveInteger(regionRaw);
      if (!parsed) {
        return reply.status(400).send({ error: 'Некорректный регион.' });
      }
      regionId = parsed;
    }
    const result = db.prepare(
      'DELETE FROM market_watchlist WHERE user_id = ? AND type_id = ? AND region_id = ?',
    ).run(session.userId, typeId, regionId);
    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Позиция не найдена в списке наблюдения.' });
    }
    return { ok: true };
  });
}

const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const GROUP_TYPES_DEFAULT_LIMIT = 100;
const GROUP_TYPES_MAX_LIMIT = 200;
const ORDERS_DEFAULT_LIMIT = 50;
const ORDERS_MAX_LIMIT = 100;
const HISTORY_DEFAULT_DAYS = 90;
// 0 means "all stored rows" and maps to days=null in getTypeHistory.
const HISTORY_ALLOWED_DAYS = new Set([0, 30, 90, 365]);
const WATCHLIST_MAX_ITEMS = 100;
// SDE reference data changes once per game patch; the onRequest hook above
// pins every market route to no-store, static-SDE routes override it here so
// the browser may reuse the response for a few minutes (per-session: private).
const STATIC_SDE_CACHE_CONTROL = 'private, max-age=300';

function markStaticSde(reply: FastifyReply): void {
  void reply.header('Cache-Control', STATIC_SDE_CACHE_CONTROL);
}

type SearchQuery = { q?: string; limit?: string };
type GroupsQuery = { parent?: string };
type LimitQuery = { limit?: string };
type RegionQuery = { region_id?: string };
type OrdersQuery = { region_id?: string; side?: string; offset?: string; limit?: string };
type HistoryQuery = { region_id?: string; days?: string };
type InfoQuery = { lang?: 'en' | 'ru' };
type GroupParams = { groupId: string };
type TypeParams = { typeId: string };

type WatchlistRow = {
  type_id: number;
  type_name: string | null;
  region_id: number;
  best_sell: number | null;
  best_buy: number | null;
  created_at: string;
};

const WATCHLIST_SELECT = `
  SELECT
    w.type_id AS type_id,
    t.name AS type_name,
    w.region_id AS region_id,
    (SELECT MIN(o.price) FROM market_orders o
      WHERE o.type_id = w.type_id AND o.region_id = w.region_id AND o.is_buy_order = 0) AS best_sell,
    (SELECT MAX(o.price) FROM market_orders o
      WHERE o.type_id = w.type_id AND o.region_id = w.region_id AND o.is_buy_order = 1) AS best_buy,
    w.created_at AS created_at
  FROM market_watchlist w
  LEFT JOIN sde_types t ON t.type_id = w.type_id
`;

function readWatchlistItems(db: Db, userId: number): WatchlistRow[] {
  return db.prepare(`
    ${WATCHLIST_SELECT}
    WHERE w.user_id = ?
    ORDER BY w.created_at ASC, w.type_id ASC
  `).all(userId) as WatchlistRow[];
}

function readWatchlistItem(db: Db, userId: number, typeId: number, regionId: number): WatchlistRow | undefined {
  return db.prepare(`
    ${WATCHLIST_SELECT}
    WHERE w.user_id = ? AND w.type_id = ? AND w.region_id = ?
  `).get(userId, typeId, regionId) as WatchlistRow | undefined;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** JSON bodies carry numbers; tolerate quoted integers from naive clients. */
function parseBodyPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') return parsePositiveInteger(value);
  return null;
}

/**
 * Optional query integer: undefined when absent (caller applies its default),
 * null when present but not an integer inside [min, max] (caller sends a 400).
 */
function parseOptionalBoundedInteger(value: string | undefined, min: number, max: number): number | null | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/** Required region_id query parameter; sends the 400 itself and returns null. */
function parseRequiredRegionId(value: string | undefined, reply: FastifyReply): number | null {
  if (value === undefined || value === '') {
    void reply.status(400).send({ error: 'Параметр region_id обязателен.' });
    return null;
  }
  const parsed = parsePositiveInteger(value);
  if (!parsed) {
    void reply.status(400).send({ error: 'Некорректный регион.' });
    return null;
  }
  return parsed;
}
