import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import {
  runMarketAiSearch,
  type MarketAiSearchOutcome,
} from '../agent/market-ai-search.js';
import type { UserContext } from '../auth/user-resolver.js';
import { loadTradeRegions } from '../eve/market-wide-summary.js';
import { recordModelUsageSafe } from '../usage/tracker.js';
import { admitWebEvent } from './web-admission.js';
import { buildWebClientIpKey } from './web-session.js';
import { requireMutationSession } from './web-route-guards.js';

/**
 * POST /api/web/market/ai-search — подбор предметов естественным языком через
 * лёгкий исполнитель агента (sde_sql + batch_market_prices, жёсткий бюджет).
 * Мутация по гвардам (сессия + CSRF/origin), хотя состояние не меняется:
 * вызов стоит токены модели, поэтому защищаем как POST, пишем usage_events
 * каналом web и проводим через общий допуск (web-admission.ts): те же окна и
 * cost-units бюджеты, что у чат-очереди, с admission-событием 'ai-search'.
 * Раннер инжектируется — тесты подменяют его без сети.
 */
export type MarketAiSearchRunner = (
  db: Db,
  query: string,
  ctx: UserContext,
  regionId: number,
) => Promise<MarketAiSearchOutcome>;

const QUERY_MIN_LENGTH = 2;
const QUERY_MAX_LENGTH = 500;
const USAGE_THREAD_ID = 'web-market-ai-search';
/** Дешевле корневого хода чата (4): один лёгкий раннер без субагентов. */
const AI_SEARCH_COST_UNITS = 2;
const UNAVAILABLE_ERROR = 'Модель сейчас недоступна. Попробуйте повторить через минуту.';
const RETRY_AFTER_UNAVAILABLE_SECONDS = 60;

type AiSearchBody = { query?: unknown; region_id?: unknown };

export function registerMarketAiSearchRoutes(
  app: FastifyInstance,
  db: Db,
  runner: MarketAiSearchRunner = runMarketAiSearch,
): void {
  app.post<{ Body: AiSearchBody }>('/api/web/market/ai-search', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;

    if (!config.web.aiSearchEnabled) {
      reply.header('Retry-After', String(RETRY_AFTER_UNAVAILABLE_SECONDS));
      return reply.status(503).send({ error: 'АИ-поиск временно отключён.' });
    }

    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Некорректное тело запроса.' });
    }
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (query.length < QUERY_MIN_LENGTH || query.length > QUERY_MAX_LENGTH) {
      return reply.status(400).send({ error: `Запрос должен содержать от ${QUERY_MIN_LENGTH} до ${QUERY_MAX_LENGTH} символов.` });
    }
    let regionId = config.market.defaultRegionId;
    if (body.region_id !== undefined && body.region_id !== null) {
      const raw = body.region_id;
      const parsed = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
      if (parsed === null) {
        return reply.status(400).send({ error: 'Некорректный регион.' });
      }
      regionId = parsed;
    }
    // Только регионы с публичным стаканом ESI. Пустой список — SDE ещё не
    // загружен: не валидируем, поиск и так деградирует честно.
    const tradeRegions = loadTradeRegions(db);
    if (tradeRegions.length > 0 && !tradeRegions.some((region) => region.region_id === regionId)) {
      return reply.status(400).send({ error: 'Некорректный регион.' });
    }

    const admission = admitWebEvent(db, {
      eventKind: 'ai-search',
      userId: session.userId,
      ipKey: buildWebClientIpKey(request.ip),
      costUnits: AI_SEARCH_COST_UNITS,
    });
    if (!admission.ok) {
      if (admission.retryAfterSeconds > 0) {
        reply.header('Retry-After', String(admission.retryAfterSeconds));
      }
      return reply.status(admission.statusCode).send({ error: admission.error });
    }

    let outcome: MarketAiSearchOutcome;
    try {
      outcome = await runner(db, query, { userId: session.userId, chatId: session.chatId }, regionId);
    } catch (error) {
      // Как executor: наружу — честный 503 без внутренностей провайдера,
      // подробности только в серверный лог.
      console.error(
        '[market-ai-search] runner failed category=runner_failure detail=%s',
        error instanceof Error ? error.message : String(error),
      );
      reply.header('Retry-After', String(RETRY_AFTER_UNAVAILABLE_SECONDS));
      return reply.status(503).send({ error: UNAVAILABLE_ERROR });
    }
    if (outcome.usage) {
      // The AI-search runner never overrides the model, so the config model is
      // the one that actually served the call (required-arg contract from the
      // per-user settings work).
      recordModelUsageSafe(db, { userId: session.userId, chatId: session.chatId }, USAGE_THREAD_ID, outcome.usage, config.openai.model);
    }
    if (!outcome.ok) {
      reply.header('Retry-After', String(RETRY_AFTER_UNAVAILABLE_SECONDS));
      return reply.status(503).send({ error: UNAVAILABLE_ERROR });
    }

    return { ok: true, results: hydratePicks(db, outcome.picks, regionId) };
  });
}

type HydratedPick = {
  type_id: number;
  name: string;
  reason: string;
  best_sell: number | null;
  best_buy: number | null;
};

/**
 * Имена и лучшие цены по локальному снапшоту в выбранном регионе. Предметы,
 * которых нет в SDE (модель прислала лишний id), отбрасываются; порядок
 * сохраняется за моделью.
 */
function hydratePicks(
  db: Db,
  picks: Array<{ type_id: number; reason: string }>,
  regionId: number,
): HydratedPick[] {
  if (picks.length === 0) return [];
  const placeholders = picks.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT t.type_id AS type_id, t.name AS name,
      (SELECT MIN(o.price) FROM market_orders o
        WHERE o.type_id = t.type_id AND o.region_id = ? AND o.is_buy_order = 0) AS best_sell,
      (SELECT MAX(o.price) FROM market_orders o
        WHERE o.type_id = t.type_id AND o.region_id = ? AND o.is_buy_order = 1) AS best_buy
    FROM sde_types t
    WHERE t.type_id IN (${placeholders})
  `).all(regionId, regionId, ...picks.map((pick) => pick.type_id)) as Array<{
    type_id: number;
    name: string;
    best_sell: number | null;
    best_buy: number | null;
  }>;
  const byId = new Map(rows.map((row) => [row.type_id, row]));
  return picks.flatMap((pick) => {
    const row = byId.get(pick.type_id);
    return row ? [{
      type_id: row.type_id,
      name: row.name,
      reason: pick.reason,
      best_sell: row.best_sell,
      best_buy: row.best_buy,
    }] : [];
  });
}
