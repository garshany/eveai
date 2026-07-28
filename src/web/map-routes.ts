/**
 * Perimeter HTTP surface.
 *
 * Read routes serve the map; the SSE route is the only one that holds a live
 * ESI poll open, and it releases it the moment the request aborts. Model-touching
 * routes go through the same admission and quota layer as chat — the map must
 * not become a side door around the operator's spend controls.
 *
 * Degradation is deliberate and layered: a guest gets the public map, a linked
 * pilot without the location scope gets the public map plus a named missing
 * scope, and only a pilot with the scope gets a position and advisories.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { getLinkedCharacter } from '../eve/sso.js';
import {
  getMapGraphMeta,
  getMapSystem,
  routeWithRisk,
  type RouteMode,
} from '../eve/map-graph.js';
import { buildBubble } from '../eve-map/bubble.js';
import { getRecentKills, getKillIndexStatus, onIndexedKill } from '../eve-map/kill-index.js';
import {
  attachLiveSession,
  getLiveSessionStats,
  type LiveLocation,
} from '../eve-map/live-session.js';
import {
  createAdvisorState,
  evaluateAdvisories,
  markModelCall,
  shouldEscalateToModel,
  type Advisory,
  type AdvisorState,
} from '../eve-map/advisor.js';
import {
  appendAdvisory,
  getOrCreatePerimeterThread,
  readPerimeterHistory,
} from '../eve-map/thread.js';
import { admitWebEvent } from './web-admission.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import { buildWebClientIpKey } from './web-session.js';
import type { WebSession } from './web-session.js';

const LOCATION_SCOPE = 'esi-location.read_location.v1';
const HEARTBEAT_MS = 15_000;
const MAX_ROUTE_AVOID = 100;

type BubbleQuery = { system_id?: string; radius?: string };
type SystemQuery = { system_id?: string };
type RouteBody = {
  origin?: unknown;
  destination?: unknown;
  mode?: unknown;
  risk?: unknown;
  avoid?: unknown;
  useWormholes?: unknown;
};
type AskBody = { message?: unknown };

export function registerMapRoutes(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/web/map/')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  // -- Status -------------------------------------------------------------
  // Answers "can this screen work at all" before the client draws anything, so
  // a missing SDE or a missing scope produces an explanation instead of an
  // empty canvas.
  app.get('/api/web/map/status', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const graph = getMapGraphMeta(db);
    const linked = getLinkedCharacter(db, sessionContext(session));
    return {
      graph: graph
        ? {
          ready: true,
          systemCount: graph.systemCount,
          edgeCount: graph.edgeCount,
          geometrySource: graph.geometrySource,
          builtAt: graph.builtAt,
        }
        : { ready: false, reason: 'The map graph has not been built. The operator must load the SDE.' },
      character: linked
        ? {
          characterId: linked.characterId,
          characterName: linked.characterName,
          hasLocationScope: linked.scopes.includes(LOCATION_SCOPE),
          missingScope: linked.scopes.includes(LOCATION_SCOPE) ? null : LOCATION_SCOPE,
        }
        : null,
      limits: {
        defaultRadius: config.map.bubbleDefaultRadius,
        maxRadius: config.map.bubbleMaxRadius,
        maxNodes: config.map.bubbleMaxNodes,
        pollSeconds: config.map.locationPollSeconds,
      },
      live: getLiveSessionStats(),
      killIndex: getKillIndexStatus(db),
    };
  });

  // -- Bubble -------------------------------------------------------------
  app.get<{ Querystring: BubbleQuery }>('/api/web/map/bubble', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    if (!getMapGraphMeta(db)) {
      return reply.status(503).send({ error: 'Карта недоступна: граф систем не построен.' });
    }

    const origin = await resolveOrigin(db, session, request.query.system_id, reply);
    if (origin === null) return;
    const radius = parseRadius(request.query.radius);

    const bubble = await buildBubble(db, origin.systemId, {
      radius,
      shipTypeId: origin.shipTypeId,
    });
    return { bubble, origin };
  });

  // -- System inspector ---------------------------------------------------
  app.get<{ Querystring: SystemQuery }>('/api/web/map/system', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const systemId = Number(request.query.system_id);
    if (!Number.isSafeInteger(systemId) || systemId <= 0) {
      return reply.status(400).send({ error: 'system_id обязателен.' });
    }
    const system = getMapSystem(db, systemId);
    if (!system) return reply.status(404).send({ error: 'Система не найдена в графе карты.' });
    return {
      system,
      kills: getRecentKills(db, systemId, { limit: 30 }).map((kill) => ({
        ...kill,
        url: `https://eve-kill.com/kill/${kill.killmailId}`,
      })),
    };
  });

  // -- Routing ------------------------------------------------------------
  app.post<{ Body: RouteBody }>('/api/web/map/route', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const body = request.body ?? {};
    const origin = Number(body.origin);
    const destination = Number(body.destination);
    if (!Number.isSafeInteger(origin) || !Number.isSafeInteger(destination)) {
      return reply.status(400).send({ error: 'origin и destination должны быть числовыми ID систем.' });
    }
    const mode = parseMode(body.mode);
    const risk = parseRisk(body.risk);
    const avoid = parseAvoid(body.avoid);
    if (avoid === null) {
      return reply.status(400).send({ error: `avoid не должен превышать ${MAX_ROUTE_AVOID} систем.` });
    }

    // The danger weights come from a bubble centred on the origin: routing
    // beyond it falls back to zero danger rather than pretending to know.
    const bubble = await buildBubble(db, origin, {
      radius: config.map.bubbleMaxRadius,
      skipBackfill: true,
    });
    const dangerBySystem = new Map(bubble.systems.map((system) => [system.systemId, system.danger.score]));

    const route = routeWithRisk(db, origin, destination, {
      mode,
      riskWeight: risk,
      avoid,
      dangerOf: (systemId) => dangerBySystem.get(systemId) ?? 0,
      extraEdges: body.useWormholes === true
        ? bubble.wormholes.map((link) => [link.fromSystemId, link.toSystemId] as [number, number])
        : [],
    });

    return {
      route,
      systems: route.systemIds.map((systemId) => {
        const system = getMapSystem(db, systemId);
        return {
          systemId,
          name: system?.name ?? `System ${systemId}`,
          security: system?.security ?? 0,
          danger: dangerBySystem.get(systemId) ?? null,
        };
      }),
      dangerCoverage: {
        knownSystems: route.systemIds.filter((id) => dangerBySystem.has(id)).length,
        totalSystems: route.systemIds.length,
      },
    };
  });

  // -- Perimeter chat -----------------------------------------------------
  app.get('/api/web/map/chat', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = getLinkedCharacter(db, sessionContext(session));
    const threadId = getOrCreatePerimeterThread(
      db, session.chatId, session.userId, linked?.characterId ?? null,
    );
    return { threadId, messages: readPerimeterHistory(db, threadId) };
  });

  app.post<{ Body: AskBody }>('/api/web/map/ask', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
    if (!message) return reply.status(400).send({ error: 'Пустое сообщение.' });
    if (message.length > 4000) return reply.status(400).send({ error: 'Слишком длинное сообщение.' });

    // The map is not a bypass around the operator's spend controls: the same
    // admission gate the chat lane uses applies here, with the same event kind.
    const admission = admitWebEvent(db, {
      eventKind: 'chat',
      userId: session.userId,
      ipKey: buildWebClientIpKey(clientIp(request)),
      costUnits: 1,
    });
    if (!admission.ok) {
      return reply
        .status(admission.statusCode)
        .header('Retry-After', String(admission.retryAfterSeconds))
        .send({ error: admission.error });
    }

    const linked = getLinkedCharacter(db, sessionContext(session));
    const threadId = getOrCreatePerimeterThread(
      db, session.chatId, session.userId, linked?.characterId ?? null,
    );
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)")
      .run(threadId, message);
    db.prepare("UPDATE agent_threads SET updated_at = datetime('now') WHERE thread_id = ?")
      .run(threadId);

    return reply.status(202).send({ threadId, accepted: true });
  });

  // -- Live stream --------------------------------------------------------
  app.get('/api/web/map/live', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = getLinkedCharacter(db, sessionContext(session));
    if (!linked) {
      return reply.status(403).send({ error: 'Свяжите персонажа EVE, чтобы видеть себя на карте.' });
    }
    if (!linked.scopes.includes(LOCATION_SCOPE)) {
      return reply.status(403).send({
        error: 'Нет доступа к позиции персонажа.',
        missingScope: LOCATION_SCOPE,
      });
    }

    const stream = openStream(reply, request);
    const state = createAdvisorState();
    const threadId = getOrCreatePerimeterThread(
      db, session.chatId, session.userId, linked.characterId,
    );
    const locale = readLocale(request);

    let currentSystemId: number | null = null;
    let lastShipTypeId: number | null = null;
    let pendingKills: Array<{ killmailId: number; systemId: number }> = [];
    let refreshing = false;

    const bubbleSystemIds = new Set<number>();

    const refresh = async (shipTypeId: number | null, reason: 'jump' | 'tick'): Promise<void> => {
      if (currentSystemId === null || refreshing || stream.closed) return;
      refreshing = true;
      try {
        const next = await buildBubble(db, currentSystemId, {
          shipTypeId,
          // A five-second tick must never pay for a cold-start fan-out; only a
          // jump into new space is allowed to backfill.
          skipBackfill: reason === 'tick',
        });
        bubbleSystemIds.clear();
        for (const system of next.systems) bubbleSystemIds.add(system.systemId);
        stream.send('intel', { bubble: next });

        const advisories = evaluateAdvisories(state, {
          bubble: next,
          currentSystemId,
          routeAhead: [],
          newKills: next.recentKills.filter(
            (kill) => pendingKills.some((pending) => pending.killmailId === kill.killmailId),
          ),
          now: Date.now(),
        });
        pendingKills = [];
        for (const advisory of advisories) {
          publishAdvisory(db, threadId, advisory, locale, state, stream);
        }
      } catch (error) {
        stream.send('warning', { message: (error as Error).message });
      } finally {
        refreshing = false;
      }
    };

    const attached = attachLiveSession(db, sessionContext(session), linked.characterId, (event) => {
      if (stream.closed) return;
      if (event.type === 'offline') {
        stream.send('offline', { at: event.at });
        return;
      }
      if (event.type === 'error') {
        stream.send('warning', { message: event.message, fatal: event.fatal });
        if (event.fatal) stream.close();
        return;
      }
      const location: LiveLocation = event.location;
      const jumped = event.jumped || currentSystemId !== location.solarSystemId;
      currentSystemId = location.solarSystemId;
      lastShipTypeId = location.shipTypeId;
      stream.send('location', { location, jumped, previousSystemId: event.previousSystemId });
      if (jumped) void refresh(location.shipTypeId, 'jump');
    });

    if (!attached.ok) {
      stream.abortBeforeStart();
      return reply
        .status(attached.statusCode)
        .header('Retry-After', String(attached.retryAfterSeconds))
        .send({ error: attached.error });
    }

    // Live kills inside the bubble are pushed the moment the index sees them,
    // rather than waiting for the next intel tick.
    const unsubscribeKills = onIndexedKill((kill) => {
      if (stream.closed || !bubbleSystemIds.has(kill.systemId)) return;
      pendingKills.push({ killmailId: kill.killmailId, systemId: kill.systemId });
      stream.send('kill', { kill });
    });

    const intelTimer = setInterval(() => {
      void refresh(lastShipTypeId, 'tick');
    }, config.map.intelRefreshSeconds * 1000);
    intelTimer.unref?.();

    stream.onClose(() => {
      clearInterval(intelTimer);
      unsubscribeKills();
      attached.detach();
    });

    stream.send('ready', {
      characterId: linked.characterId,
      threadId,
      pollSeconds: config.map.locationPollSeconds,
    });
    return reply;
  });
}

// ---------------------------------------------------------------------------
// Advisory publication
// ---------------------------------------------------------------------------

/**
 * One advisory becomes one persisted assistant message *and* one stream event.
 * Persisting first is deliberate: if the stream dies between the two, the pilot
 * still finds the warning in the thread when they reconnect.
 */
function publishAdvisory(
  db: Db,
  threadId: string,
  advisory: Advisory,
  locale: 'ru' | 'en',
  state: AdvisorState,
  stream: SseStream,
): void {
  const now = Date.now();
  // The rule text is already complete and correct; escalation only buys tone,
  // so it is rationed and never blocks the warning itself.
  const escalate = shouldEscalateToModel(state, [advisory], now);
  if (escalate) markModelCall(state, now);
  const message = appendAdvisory(db, threadId, advisory, locale, 'rule');
  stream.send('advisory', { advisory, message, escalated: escalate });
}

// ---------------------------------------------------------------------------
// SSE helper
// ---------------------------------------------------------------------------

type SseStream = {
  closed: boolean;
  send: (event: string, payload: unknown) => void;
  close: () => void;
  onClose: (handler: () => void) => void;
  abortBeforeStart: () => void;
};

/**
 * Mirrors the chat lane's SSE shape: monotonic ids so a `Last-Event-ID`
 * reconnect does not replay, heartbeats so proxies keep the socket, and a
 * single idempotent close path that every teardown funnels through.
 */
function openStream(reply: FastifyReply, request: FastifyRequest): SseStream {
  const rawLastEventId = request.headers['last-event-id'];
  let sequence = typeof rawLastEventId === 'string' && /^\d+$/.test(rawLastEventId)
    ? Number(rawLastEventId)
    : 0;

  let started = false;
  let closed = false;
  const closeHandlers: Array<() => void> = [];

  const start = (): void => {
    if (started) return;
    started = true;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch (error) {
        console.warn('[map-sse] close handler failed: %s', (error as Error).message);
      }
    }
    if (started && !reply.raw.writableEnded) reply.raw.end();
  };

  const heartbeat = setInterval(() => {
    if (closed || !started) return;
    reply.raw.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  request.raw.once('close', close);

  return {
    get closed() { return closed; },
    send(event, payload) {
      if (closed) return;
      start();
      sequence += 1;
      reply.raw.write(`id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    close,
    onClose(handler) { closeHandlers.push(handler); },
    // Used when the session was refused before any byte was written, so the
    // route can still answer with a normal JSON status code.
    abortBeforeStart() {
      clearInterval(heartbeat);
      closed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

async function resolveOrigin(
  db: Db,
  session: WebSession,
  requested: string | undefined,
  reply: FastifyReply,
): Promise<{ systemId: number; shipTypeId: number | null; source: 'explicit' | 'pilot' } | null> {
  if (requested !== undefined) {
    const systemId = Number(requested);
    if (!Number.isSafeInteger(systemId) || systemId <= 0) {
      void reply.status(400).send({ error: 'system_id должен быть числовым ID системы.' });
      return null;
    }
    if (!getMapSystem(db, systemId)) {
      void reply.status(404).send({ error: 'Система не найдена в графе карты.' });
      return null;
    }
    return { systemId, shipTypeId: null, source: 'explicit' };
  }

  const linked = getLinkedCharacter(db, sessionContext(session));
  if (!linked || !linked.scopes.includes(LOCATION_SCOPE)) {
    void reply.status(400).send({
      error: 'Укажите system_id или свяжите персонажа с доступом к позиции.',
      missingScope: linked ? LOCATION_SCOPE : null,
    });
    return null;
  }
  const { getLiveSession } = await import('../eve-map/live-session.js');
  const live = getLiveSession(linked.characterId);
  if (live?.lastLocation) {
    return {
      systemId: live.lastLocation.solarSystemId,
      shipTypeId: live.lastLocation.shipTypeId,
      source: 'pilot',
    };
  }
  void reply.status(409).send({
    error: 'Позиция ещё неизвестна. Откройте живой поток карты или укажите system_id.',
  });
  return null;
}

function parseRadius(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return config.map.bubbleDefaultRadius;
  return Math.max(1, Math.min(config.map.bubbleMaxRadius, Math.floor(value)));
}

function parseMode(raw: unknown): RouteMode {
  return raw === 'secure' || raw === 'insecure' ? raw : 'shortest';
}

function parseRisk(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  // Beyond this the router stops trading jumps for safety and starts refusing
  // to move, which reads as a broken planner rather than a cautious one.
  return Math.min(20, value);
}

function parseAvoid(raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_ROUTE_AVOID) return null;
  const ids: number[] = [];
  for (const entry of raw) {
    const value = Number(entry);
    if (Number.isSafeInteger(value) && value > 0) ids.push(value);
  }
  return ids;
}

function readLocale(request: FastifyRequest): 'ru' | 'en' {
  const header = request.headers['accept-language'];
  if (typeof header === 'string' && /^en/i.test(header.trim())) return 'en';
  return 'ru';
}

function clientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

function sessionContext(session: WebSession) {
  return { userId: session.userId, chatId: session.chatId, notificationCapability: 'web' as const };
}

/** Exported for tests that need a synthetic advisory publication. */
export const __testables = { publishAdvisory, parseRisk, parseAvoid, parseRadius };
