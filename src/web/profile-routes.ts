import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { getLinkedCharacter } from '../eve/sso.js';
import {
  characterDatasetRequirements,
  getCharacterDatasetStatuses,
  refreshCharacterDatasets,
  type CharacterDatasetId,
  type CharacterDatasetStatus,
} from '../eve/character-sync.js';
import { getMarketSnapshotMeta } from '../eve/market-snapshot-loader.js';
import {
  accessSummary,
  activeOrders,
  assetLocations,
  clonesSummary,
  locationItems,
  sanitizeDatasetError,
  skillsSummary,
  walletSummary,
} from './profile-data.js';
import { cleanExpiredWebSessions } from './web-session.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import type { WebSession } from './web-session.js';

/**
 * "Living profile" HTTP API: read-only projections of the materialized
 * character datastore (see profile-data.ts) plus a manual sync trigger.
 * Reads never touch ESI — they serve SQLite rows and report per-dataset
 * freshness from character_sync_state; POST /sync is the only route that can
 * reach ESI and it is CSRF-protected and manually rate-limited (a dataset
 * synced less than MANUAL_SYNC_COOLDOWN_MS ago is not refetched).
 * Everything is scoped to the session's ACTIVE linked character; there is no
 * character_id parameter by design.
 */
export function registerProfileRoutes(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/web/profile/')) {
      void cleanExpiredWebSessions(db);
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.get<{ Querystring: PaginationQuery }>('/api/web/profile/assets', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = requireLinkedCharacter(db, session, reply);
    if (!linked) return;
    const pagination = parsePagination(request.query, reply);
    if (!pagination) return;
    const { locations, total } = assetLocations(
      db, linked.characterId, pagination.limit, pagination.offset,
    );
    return {
      freshness: freshnessFor(db, linked.characterId, ['assets']),
      priceBook: priceBookMeta(db),
      locations,
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  });

  app.get<{ Querystring: ItemsQuery }>('/api/web/profile/assets/items', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = requireLinkedCharacter(db, session, reply);
    if (!linked) return;
    const locationIdRaw = request.query.location_id;
    if (locationIdRaw === undefined || locationIdRaw === '') {
      return reply.status(400).send({ error: 'Параметр location_id обязателен.' });
    }
    const locationId = parsePositiveInteger(locationIdRaw);
    if (!locationId) {
      return reply.status(400).send({ error: 'Некорректный идентификатор локации.' });
    }
    const pagination = parsePagination(request.query, reply);
    if (!pagination) return;
    const { items, total } = locationItems(
      db, linked.characterId, locationId, pagination.limit, pagination.offset,
    );
    return {
      freshness: freshnessFor(db, linked.characterId, ['assets']),
      items,
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  });

  app.get<{ Querystring: PaginationQuery }>('/api/web/profile/orders', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = requireLinkedCharacter(db, session, reply);
    if (!linked) return;
    const pagination = parsePagination(request.query, reply);
    if (!pagination) return;
    const { orders, total, totals } = activeOrders(
      db, linked.characterId, pagination.limit, pagination.offset,
    );
    return {
      freshness: freshnessFor(db, linked.characterId, ['orders']),
      orders,
      total,
      totals,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  });

  app.get('/api/web/profile/wallet', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = requireLinkedCharacter(db, session, reply);
    if (!linked) return;
    const { balance, journal } = walletSummary(db, linked.characterId);
    return {
      freshness: freshnessFor(db, linked.characterId, ['wallet', 'wallet_journal']),
      balance,
      journal,
    };
  });

  app.get('/api/web/profile/clones', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = requireLinkedCharacter(db, session, reply);
    if (!linked) return;
    const { home, jumpClones, currentImplants } = clonesSummary(db, linked.characterId);
    return {
      freshness: freshnessFor(db, linked.characterId, ['clones']),
      home,
      jumpClones,
      currentImplants,
    };
  });

  app.get('/api/web/profile/skills', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = requireLinkedCharacter(db, session, reply);
    if (!linked) return;
    const { totalSp, unallocatedSp, queue } = skillsSummary(db, linked.characterId);
    return {
      freshness: freshnessFor(db, linked.characterId, ['skills', 'skillqueue']),
      totalSp,
      unallocatedSp,
      queue,
    };
  });

  app.get('/api/web/profile/access', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = requireLinkedCharacter(db, session, reply);
    if (!linked) return;
    const { scopes, groups, datasets } = accessSummary(db, linked.characterId, linked.scopes);
    return { freshness: null, scopes, groups, datasets };
  });

  app.post('/api/web/profile/sync', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const linked = requireLinkedCharacter(db, session, reply);
    if (!linked) return;
    const body = request.body;
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) {
      return reply.status(400).send({ error: 'Некорректное тело запроса.' });
    }
    const datasetsRaw = (body as Record<string, unknown> | undefined)?.datasets;
    let datasets: CharacterDatasetId[];
    if (datasetsRaw === undefined) {
      datasets = ALL_DATASET_IDS;
    } else {
      if (!Array.isArray(datasetsRaw) || datasetsRaw.some((value) => typeof value !== 'string')) {
        return reply.status(400).send({ error: 'Поле datasets должно быть массивом строк.' });
      }
      const unknown = datasetsRaw.filter((value) => !DATASET_ID_SET.has(value as CharacterDatasetId));
      if (unknown.length > 0) {
        return reply.status(400).send({ error: `Неизвестный набор данных: ${unknown.join(', ')}.` });
      }
      datasets = [...new Set(datasetsRaw)] as CharacterDatasetId[];
    }

    // Manual cooldown: a dataset synced less than a minute ago is served
    // as-is, and a failed sync backs off until its expires_at instead of
    // re-hitting a struggling ESI on every button press.
    const current = getCharacterDatasetStatuses(db, linked.characterId, datasets);
    const due = datasets.filter((dataset, index) => !withinManualSyncCooldown(current[index]!));
    if (due.length > 0) {
      // A manual sync is bounded: without a deadline 10 datasets x 50 pages
      // x 5 attempts would hold the request for tens of minutes. The signal
      // reaches the ESI fetch layer, so a firing deadline actually stops the
      // sync instead of just abandoning the HTTP response.
      const signal = AbortSignal.timeout(config.web.profileSyncTimeoutMs);
      await refreshCharacterDatasets(db, sessionContext(session), due, { signal });
      if (signal.aborted) {
        reply.header('Retry-After', String(Math.ceil(MANUAL_SYNC_COOLDOWN_MS / 1000)));
        return reply.status(503).send({
          error: 'Синхронизация не уложилась в отведённое время. Попробуйте позже.',
          statuses: getCharacterDatasetStatuses(db, linked.characterId, datasets).map(toSyncStatus),
        });
      }
    }

    return {
      statuses: getCharacterDatasetStatuses(db, linked.characterId, datasets).map(toSyncStatus),
    };
  });
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MANUAL_SYNC_COOLDOWN_MS = 60_000;

const ALL_DATASET_IDS = characterDatasetRequirements().map((entry) => entry.id);
const DATASET_ID_SET = new Set<CharacterDatasetId>(ALL_DATASET_IDS);

type PaginationQuery = { limit?: string; offset?: string };
type ItemsQuery = { location_id?: string; limit?: string; offset?: string };

function sessionContext(session: WebSession) {
  return { userId: session.userId, chatId: session.chatId, notificationCapability: 'web' as const };
}

function requireLinkedCharacter(
  db: Db,
  session: WebSession,
  reply: FastifyReply,
): { characterId: number; characterName: string; scopes: string[] } | null {
  const linked = getLinkedCharacter(db, sessionContext(session));
  if (!linked) {
    void reply.status(404).send({ error: 'Персонаж не подключён.' });
    return null;
  }
  return linked;
}

function toFreshness(status: CharacterDatasetStatus) {
  return {
    dataset: status.dataset,
    status: status.status,
    syncedAt: status.synced_at,
    expiresAt: status.expires_at,
    error: sanitizeDatasetError(status.error),
  };
}

function priceBookMeta(db: Db) {
  const meta = getMarketSnapshotMeta(db, {
    staleMinutes: config.marketSnapshot.staleMinutes,
    majorMinPages: config.marketSnapshot.majorMinPages,
    majorIntervalMinutes: config.marketSnapshot.majorIntervalMinutes,
    minorIntervalMinutes: config.marketSnapshot.minorIntervalMinutes,
  });
  return {
    loaded: meta.loaded,
    snapshotTime: meta.snapshot_time,
    ageMinutes: meta.age_minutes,
    stale: meta.stale,
  };
}

function freshnessFor(db: Db, characterId: number, datasets: CharacterDatasetId[]) {
  const freshness = getCharacterDatasetStatuses(db, characterId, datasets).map(toFreshness);
  return freshness.length === 1 ? freshness[0] : freshness;
}

function toSyncStatus(status: CharacterDatasetStatus) {
  return {
    dataset: status.dataset,
    status: status.status,
    rowsSynced: status.rows_synced,
    syncedAt: status.synced_at,
    expiresAt: status.expires_at,
    error: sanitizeDatasetError(status.error),
  };
}

function isFutureSqlUtc(value: string | null): boolean {
  if (!value) return false;
  return Date.parse(value.replace(' ', 'T') + 'Z') > Date.now();
}

function withinManualSyncCooldown(status: CharacterDatasetStatus): boolean {
  // A recent failure backs off until its expires_at instead of refetching on
  // every press; any other finished sync ('ok') is fresh for a minute.
  if (status.status === 'error') return isFutureSqlUtc(status.expires_at);
  if (status.status !== 'ok' || !status.synced_at) return false;
  const syncedAt = Date.parse(status.synced_at.replace(' ', 'T') + 'Z');
  return Number.isFinite(syncedAt) && Date.now() - syncedAt < MANUAL_SYNC_COOLDOWN_MS;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

function parsePagination(
  query: PaginationQuery,
  reply: FastifyReply,
): { limit: number; offset: number } | null {
  const limit = parseOptionalBoundedInteger(query.limit, 1, MAX_PAGE_LIMIT);
  if (limit === null) {
    void reply.status(400).send({ error: `Лимит должен быть целым числом от 1 до ${MAX_PAGE_LIMIT}.` });
    return null;
  }
  const offset = parseOptionalBoundedInteger(query.offset, 0, Number.MAX_SAFE_INTEGER);
  if (offset === null) {
    void reply.status(400).send({ error: 'Смещение (offset) должно быть неотрицательным целым числом.' });
    return null;
  }
  return { limit: limit ?? DEFAULT_PAGE_LIMIT, offset: offset ?? 0 };
}
