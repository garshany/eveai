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
import { randomUUID } from 'node:crypto';
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
import { getUniverseActivity, getUniverseStatic } from '../eve-map/universe.js';
import { setAutopilotRoute } from '../eve/route-planner.js';
import {
  applyCharacterNames,
  getKillIndexStatus,
  getRecentKills,
  missingCharacterIds,
  onIndexedKill,
  resolveShipNames,
} from '../eve-map/kill-index.js';
import { resolveCharacterNames } from '../eve-map/names.js';
import {
  attachLiveSession,
  getLiveSessionStats,
  type LiveLocation,
} from '../eve-map/live-session.js';
import {
  evaluateAdvisories,
  getSharedAdvisorState,
  releaseSharedAdvisorState,
  type Advisory,
} from '../eve-map/advisor.js';
import {
  appendAdvisory,
  getOrCreatePerimeterThread,
  readPerimeterHistory,
  startNewPerimeterThread,
} from '../eve-map/thread.js';
import { rememberRoute, routeAheadOf } from '../eve-map/active-route.js';
import {
  addAvoided,
  clearAvoided,
  effectiveAvoidSet,
  listAvoided,
  removeAvoided,
} from '../eve-map/avoid.js';
export { resetActiveRoutesForTests } from '../eve-map/active-route.js';
import type { WebAgentRequestCoordinator } from './agent-requests.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import { buildWebClientIpKey } from './web-session.js';
import type { WebSession } from './web-session.js';

const LOCATION_SCOPE = 'esi-location.read_location.v1';
const WAYPOINT_SCOPE = 'esi-ui.write_waypoint.v1';

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
  /** Push the planned route into the game client's autopilot. */
  setAutopilot?: unknown;
};
type AskBody = {
  message?: unknown;
  idempotencyKey?: unknown;
  /** What the pilot is looking at, so a bare "стоит ли лететь?" is answerable. */
  context?: unknown;
};

export function registerMapRoutes(
  app: FastifyInstance,
  db: Db,
  agentRequests: WebAgentRequestCoordinator,
): void {
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

  // -- Whole cluster ------------------------------------------------------
  // Static geometry for all of New Eden. Computed once for the process and
  // immutable between SDE builds, so it is safe to cache hard in the browser —
  // the build id in the payload is the cache key.
  app.get('/api/web/map/universe', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const universe = getUniverseStatic(db);
    if (!universe) {
      return reply.status(503).send({ error: 'Карта недоступна: граф систем не построен.' });
    }
    reply.header('Cache-Control', 'private, max-age=3600');
    return universe;
  });

  // Live activity for the whole cluster: one shared rollup, not one per viewer.
  // Ten open tabs cost the same as one.
  app.get('/api/web/map/universe/intel', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    if (!getMapGraphMeta(db)) {
      return reply.status(503).send({ error: 'Карта недоступна: граф систем не построен.' });
    }
    return getUniverseActivity(db);
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

    // The feed carries ids, not names. Ship names come from the local SDE for
    // free; pilot names cost one bulk lookup, made only for the rows about to be
    // shown. Without this every line reads "неизвестный" and the panel that was
    // supposed to answer "кто кого убил" answers nothing.
    let kills = resolveShipNames(db, getRecentKills(db, systemId, { limit: 30 }));
    const names = await resolveCharacterNames(db, missingCharacterIds(kills));
    kills = applyCharacterNames(kills, names);

    return {
      system,
      kills: kills.map((kill) => ({
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

    // The stored avoid list applies to every route this account plans, not just
    // the ones where the client remembered to resend it. Origin and destination
    // are exempt: flying *to* a system you once avoided must still be routable.
    const effectiveAvoid = effectiveAvoidSet(db, session.userId, avoid, [origin, destination]);

    const route = routeWithRisk(db, origin, destination, {
      mode,
      riskWeight: risk,
      avoid: effectiveAvoid,
      dangerOf: (systemId) => dangerBySystem.get(systemId) ?? 0,
      extraEdges: body.useWormholes === true
        ? bubble.wormholes.map((link) => [link.fromSystemId, link.toSystemId] as [number, number])
        : [],
    });

    rememberRoute(session.chatId, {
      systemIds: route.ok ? route.systemIds : [],
      mode,
      riskWeight: risk,
    });

    // Planning a route on the map and then retyping it into the client is the
    // gap that makes a planner useless in flight. Same ESI write, same abort
    // guards, same scope check as the chat planner.
    let autopilot: { requested: boolean; ok: boolean; mode: string; error: string | null } = {
      requested: false, ok: false, mode: 'none', error: null,
    };
    if (body.setAutopilot === true && route.ok) {
      const linked = getLinkedCharacter(db, sessionContext(session));
      if (!linked) {
        autopilot = { requested: true, ok: false, mode: 'none', error: 'Персонаж не связан.' };
      } else if (!linked.scopes.includes(WAYPOINT_SCOPE)) {
        autopilot = {
          requested: true, ok: false, mode: 'none', error: `Нет разрешения ${WAYPOINT_SCOPE}.`,
        };
      } else {
        try {
          const written = await setAutopilotRoute(
            db, route.systemIds, destination, sessionContext(session), () => true,
          );
          autopilot = { requested: true, ok: written.ok, mode: written.mode, error: null };
        } catch (error) {
          autopilot = { requested: true, ok: false, mode: 'none', error: (error as Error).message };
        }
      }
    }

    return {
      route,
      autopilot,
      avoided: [...effectiveAvoid],
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

  // -- Avoid list ---------------------------------------------------------
  app.get('/api/web/map/avoid', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    return { systems: listAvoided(db, session.userId) };
  });

  app.post<{ Body: { systemId?: unknown; note?: unknown } }>(
    '/api/web/map/avoid',
    async (request, reply) => {
      const session = requireMutationSession(db, request, reply);
      if (!session) return;
      const systemId = Number(request.body?.systemId);
      if (!Number.isSafeInteger(systemId) || systemId <= 0) {
        return reply.status(400).send({ error: 'systemId должен быть числовым ID системы.' });
      }
      const note = typeof request.body?.note === 'string'
        ? request.body.note.trim().slice(0, 200)
        : null;
      const result = addAvoided(db, session.userId, systemId, note || null);
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return { entry: result.entry, alreadyPresent: result.alreadyPresent, systems: listAvoided(db, session.userId) };
    },
  );

  app.delete<{ Params: { systemId: string } }>(
    '/api/web/map/avoid/:systemId',
    async (request, reply) => {
      const session = requireMutationSession(db, request, reply);
      if (!session) return;
      const systemId = Number(request.params.systemId);
      if (!Number.isSafeInteger(systemId) || systemId <= 0) {
        return reply.status(400).send({ error: 'systemId должен быть числовым ID системы.' });
      }
      const removed = removeAvoided(db, session.userId, systemId);
      return { removed, systems: listAvoided(db, session.userId) };
    },
  );

  app.delete('/api/web/map/avoid', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    return { removed: clearAvoided(db, session.userId), systems: [] };
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

  app.post('/api/web/map/chat/reset', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const linked = getLinkedCharacter(db, sessionContext(session));
    // A fresh thread, not a delete: the advisor may be writing into the current
    // one at this exact moment, and the pilot's earlier warnings are evidence
    // worth keeping.
    const threadId = startNewPerimeterThread(
      db, session.chatId, session.userId, linked?.characterId ?? null,
    );
    return { threadId, messages: [] };
  });

  app.post<{ Body: AskBody }>('/api/web/map/ask', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
    if (!message) return reply.status(400).send({ error: 'Пустое сообщение.' });
    if (message.length > 4000) return reply.status(400).send({ error: 'Слишком длинное сообщение.' });

    // Admission is charged exactly once, inside enqueue: the map uses the same
    // gate and the same budget as chat. Charging here as well halved the
    // question allowance and could bill a request that enqueue then rejected.
    const linked = getLinkedCharacter(db, sessionContext(session));
    const threadId = getOrCreatePerimeterThread(
      db, session.chatId, session.userId, linked?.characterId ?? null,
    );

    // The map lane enqueues into the same durable queue as chat rather than
    // writing the question and hoping: without this the composer accepts a
    // message and no answer can ever be produced.
    const identity = db.prepare(
      'SELECT active_character_id, active_character_version FROM users WHERE user_id = ?',
    ).get(session.userId) as {
      active_character_id: number | null;
      active_character_version: number;
    } | undefined;

    const accepted = agentRequests.enqueue({
      userId: session.userId,
      chatId: session.chatId,
      threadId,
      characterId: identity?.active_character_id ?? null,
      characterVersion: identity?.active_character_version ?? 0,
      // The transcript stores what the pilot typed. Map context used to be
      // appended here and `enqueue` persists the message verbatim, so people
      // saw "[perimeter context] current_system_id=..." glued to their own
      // words. The agent reads the situation through map_bubble_intel instead.
      message,
      idempotencyKey: readIdempotencyKey(request.body?.idempotencyKey),
      ipKey: buildWebClientIpKey(clientIp(request)),
    });
    if (!accepted.ok) {
      if (accepted.retryAfterSeconds > 0) {
        reply.header('Retry-After', String(accepted.retryAfterSeconds));
      }
      return reply.status(accepted.statusCode).send({ error: accepted.error });
    }

    const requestId = accepted.request.requestId;
    return reply.status(202).send({
      threadId,
      request: accepted.request,
      pollUrl: `/api/web/chat/requests/${encodeURIComponent(requestId)}`,
      eventsUrl: `/api/web/chat/requests/${encodeURIComponent(requestId)}/events`,
    });
  });

  // -- Live stream --------------------------------------------------------
  app.get<{ Querystring: BubbleQuery }>('/api/web/map/live', async (request, reply) => {
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

    // Without this the radius slider silently does nothing once a live bubble
    // arrives: the stream always rebuilt at the operator default.
    const radius = parseRadius(request.query.radius);
    const stream = openStream(reply, request);
    // One advisor state per character, not per tab: three windows must not
    // persist the same warning into the same thread three times.
    const state = getSharedAdvisorState(linked.characterId);
    const threadId = getOrCreatePerimeterThread(
      db, session.chatId, session.userId, linked.characterId,
    );
    const locale = readLocale(request);

    let currentSystemId: number | null = null;
    let lastShipTypeId: number | null = null;
    let pendingKills: Array<{ killmailId: number; systemId: number }> = [];
    let refreshing = false;
    // A jump that lands while a build is in flight used to be dropped: the old
    // system's bubble was published while advisories were already evaluated
    // against the new position, and the map stayed on the previous system until
    // the next periodic tick.
    let refreshQueued: { shipTypeId: number | null; reason: 'jump' | 'tick' } | null = null;

    const bubbleSystemIds = new Set<number>();

    const refresh = async (shipTypeId: number | null, reason: 'jump' | 'tick'): Promise<void> => {
      if (currentSystemId === null || stream.closed) return;
      if (refreshing) {
        // A queued jump always wins over a queued tick.
        if (reason === 'jump' || refreshQueued === null) refreshQueued = { shipTypeId, reason };
        return;
      }
      refreshing = true;
      try {
        const next = await buildBubble(db, currentSystemId, {
          radius,
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
          routeAhead: routeAheadOf(session.chatId, currentSystemId),
          newKills: next.recentKills.filter(
            (kill) => pendingKills.some((pending) => pending.killmailId === kill.killmailId),
          ),
          now: Date.now(),
        });
        pendingKills = [];
        for (const advisory of advisories) {
          publishAdvisory(db, threadId, advisory, locale, stream);
        }
      } catch (error) {
        stream.send('warning', { message: (error as Error).message });
      } finally {
        refreshing = false;
        const queued = refreshQueued;
        refreshQueued = null;
        if (queued && !stream.closed) void refresh(queued.shipTypeId, queued.reason);
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
      releaseSharedAdvisorState(linked.characterId);
      attached.detach();
    });

    stream.send('ready', {
      characterId: linked.characterId,
      threadId,
      radius,
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
  stream: SseStream,
): void {
  // The rule text is complete on its own. Model-authored prose is deliberately
  // not wired here yet: the previous version consumed the escalation cooldown
  // and then persisted the rule text anyway, which is worse than not having the
  // feature — it burned the budget and reported an escalation that never
  // happened. `shouldEscalateToModel` stays as the gate for when it lands.
  const message = appendAdvisory(db, threadId, advisory, locale, 'rule');
  stream.send('advisory', { advisory, message, escalated: false });
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

function readIdempotencyKey(raw: unknown): string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(raw) ? raw : randomUUID();
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
export const __testables = {
  publishAdvisory, parseRisk, parseAvoid, parseRadius,
  readIdempotencyKey,
};
