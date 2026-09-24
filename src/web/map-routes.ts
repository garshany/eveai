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
  jumpDistance,
  routeWithRisk,
  type RouteMode,
} from '../eve/map-graph.js';
import { buildBubble } from '../eve-map/bubble.js';
import { getUniverseActivity, getUniverseStatic, getUniverseWormholes } from '../eve-map/universe.js';
import { setAutopilotRoute } from '../eve/route-planner.js';
import {
  applyCharacterNames,
  getKillIndexStatus,
  getRecentKills,
  missingCharacterIds,
  onIndexedKill,
  resolveShipNames,
  type IndexedKill,
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
import {
  clearActiveRoute,
  expireStaleRoutes,
  getActiveRoute,
  onActiveRouteChange,
  rememberRoute,
  routeAheadOf,
} from '../eve-map/active-route.js';
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
/** How long an in-bubble kill waits for company before the radar re-judges. */
const KILL_REFRESH_DEBOUNCE_MS = 1_500;
/** Bound on kills held for one evaluation; a fleet fight must not grow it forever. */
const MAX_PENDING_KILLS = 500;

type PendingKill = { kill: IndexedKill; announced: boolean };

const MAX_ROUTE_AVOID = 100;

type BubbleQuery = { system_id?: string; radius?: string };
type SystemQuery = { system_id?: string; from_system_id?: string };
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

/**
 * The identity token a long mutation pins itself to. Bumped by every character
 * switch and every unlink, so comparing it before and during a multi-call write
 * catches a pilot swapping characters mid-flight.
 */
function readActiveCharacterVersion(db: Db, userId: number): number {
  const row = db.prepare('SELECT active_character_version FROM users WHERE user_id = ?')
    .get(userId) as { active_character_version: number } | undefined;
  return row?.active_character_version ?? 0;
}

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

  // EVE-Scout exits for the whole cluster. Its own endpoint rather than a field
  // on the intel payload: EVE-Scout is cached for five minutes upstream while
  // the intel rollup refreshes every few seconds, and pinning them together
  // would make one of the two lie about its age.
  app.get('/api/web/map/universe/wormholes', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    if (!getMapGraphMeta(db)) {
      return reply.status(503).send({ error: 'Карта недоступна: граф систем не построен.' });
    }
    return getUniverseWormholes(db);
  });

  // -- System inspector ---------------------------------------------------
  app.get<{ Querystring: SystemQuery }>('/api/web/map/system', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const systemId = Number(request.query.system_id);
    if (!Number.isSafeInteger(systemId) || systemId <= 0) {
      return reply.status(400).send({ error: 'system_id обязателен.' });
    }
    const geometry = getMapSystem(db, systemId);
    if (!geometry) return reply.status(404).send({ error: 'Система не найдена в графе карты.' });

    // The full rollup, not just the geometry. The inspector opens from the whole
    // cluster map too, where the system is nowhere near the pilot's bubble and
    // the screen has no score, no activity and no camps to show it. A radius-1
    // bubble centred on the system reuses the scoring, the kill counters and the
    // camp detection instead of growing a second, subtly different copy of them.
    const rollup = await buildBubble(db, systemId, { radius: 1, skipBackfill: true });
    const scored = rollup.systems.find((entry) => entry.systemId === systemId) ?? null;

    // Distance is measured from wherever the caller says the pilot is. Answering
    // 0 when we simply do not know would read as "you are here".
    // A breadth-first walk, not the risk router: distance in jumps is
    // unweighted. Answering it with routeWithRisk ran a full Dijkstra whose
    // frontier minimum is a linear scan — O(V²) over ~8500 systems, synchronous
    // on the only thread this process has, on every click of the inspector.
    // The limit spans New Eden, which is under 100 jumps across.
    const from = Number(request.query.from_system_id);
    const jumps = Number.isSafeInteger(from) && from > 0
      ? jumpDistance(db, from, systemId, 200)
      : null;

    // The feed carries ids, not names. Ship names come from the local SDE for
    // free; pilot names cost one bulk lookup, made only for the rows about to be
    // shown. Without this every line reads "неизвестный" and the panel that was
    // supposed to answer "кто кого убил" answers nothing.
    let kills = resolveShipNames(db, getRecentKills(db, systemId, { limit: 30 }));
    const names = await resolveCharacterNames(db, missingCharacterIds(kills));
    kills = applyCharacterNames(kills, names);

    return {
      system: { ...geometry, ...(scored ?? {}), jumps },
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

    // Only a route that exists replaces the drawn one. Publishing an empty list
    // on failure deleted the line the pilot was actually following, so asking
    // for an impossible destination — or one their own avoid list blocks — wiped
    // a good route. Clearing is now an explicit act: DELETE /api/web/map/route.
    if (route.ok && route.systemIds.length >= 2) {
      rememberRoute(session.chatId, { systemIds: route.systemIds, mode, riskWeight: risk });
    }

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
          // Waypoints are written one ESI call per hop. A character switch
          // partway through would send the rest of them to the new pilot,
          // leaving two autopilots half-set. Pin the identity we started with
          // and let setAutopilotRoute stop the moment it changes — the same
          // guard the chat planner has always used.
          const startedWith = readActiveCharacterVersion(db, session.userId);
          const written = await setAutopilotRoute(
            db, route.systemIds, destination, sessionContext(session),
            () => readActiveCharacterVersion(db, session.userId) === startedWith,
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

  /**
   * Take the drawn route off the map.
   *
   * The only way to clear a line used to be to ask for a route that cannot
   * exist, because a failed plan publishes an empty one. That is not an
   * interface. Deliberately does not touch the in-game autopilot: erasing a
   * drawing and erasing the pilot's waypoints are different acts.
   */
  app.delete('/api/web/map/route', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    clearActiveRoute(session.chatId);
    return { cleared: true };
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
    // The thread lookup runs first: it can throw, and the advisor state below
    // takes a reference that must be released on every exit path.
    const threadId = getOrCreatePerimeterThread(
      db, session.chatId, session.userId, linked.characterId,
    );
    const state = getSharedAdvisorState(linked.characterId);
    const locale = readLocale(request);

    let currentSystemId: number | null = null;
    let lastShipTypeId: number | null = null;
    // Kills waiting for the next evaluation. `announced` says whether the
    // client already got a 'kill' frame for it: a kill that lands while the
    // bubble is stale (before the first build, or mid-jump) cannot be judged
    // in or out yet, so it is held unannounced and sorted by the next build
    // instead of being dropped against the wrong system set.
    let pendingKills: PendingKill[] = [];
    let refreshing = false;
    // A jump that lands while a build is in flight used to be dropped: the old
    // system's bubble was published while advisories were already evaluated
    // against the new position, and the map stayed on the previous system until
    // the next periodic tick.
    let refreshQueued: { shipTypeId: number | null; reason: 'jump' | 'tick' } | null = null;
    // A radar reacts to a kill in seconds, not at the next intel tick. Bursts
    // (a fleet fight is dozens of mails in a few seconds) share one rebuild.
    let killRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    const bubbleSystemIds = new Set<number>();
    // Origin of the bubble the client currently holds; null before the first
    // build. `bubbleSystemIds` is only authoritative while this equals the
    // pilot's current system.
    let bubbleOriginId: number | null = null;
    // The last origin whose build ran the cold-start backfill successfully.
    // Tracked instead of "was the last reason a jump": a jump build that failed
    // would otherwise leave every later tick skipping backfill for that space.
    let backfilledOriginId: number | null = null;

    const scheduleKillRefresh = (): void => {
      if (killRefreshTimer !== null || stream.closed) return;
      killRefreshTimer = setTimeout(() => {
        killRefreshTimer = null;
        void refresh(lastShipTypeId, 'tick');
      }, KILL_REFRESH_DEBOUNCE_MS);
      killRefreshTimer.unref?.();
    };

    const refresh = async (shipTypeId: number | null, reason: 'jump' | 'tick'): Promise<void> => {
      if (currentSystemId === null || stream.closed) return;
      if (refreshing) {
        // A queued jump always wins over a queued tick.
        if (reason === 'jump' || refreshQueued === null) refreshQueued = { shipTypeId, reason };
        return;
      }
      refreshing = true;
      const origin = currentSystemId;
      // Only what arrived before the build started is judged by it. Clearing
      // the list after the await used to drop kills that landed mid-build: they
      // were never announced to the advisor by any later pass.
      const batch = pendingKills;
      pendingKills = [];
      try {
        const skipBackfill = reason === 'tick' && backfilledOriginId === origin;
        const next = await buildBubble(db, origin, {
          radius,
          shipTypeId,
          // A tick must never pay for a cold-start fan-out; only new space is
          // allowed to backfill.
          skipBackfill,
        });
        if (stream.closed) return;
        if (currentSystemId !== origin) {
          // The pilot jumped while this was building. Publishing it would flash
          // the previous system's bubble, and advisories would be judged
          // against a position the pilot has already left. The jump's own
          // refresh is queued; hand it the kills.
          pendingKills = [...batch, ...pendingKills];
          return;
        }
        if (!skipBackfill) backfilledOriginId = origin;
        bubbleSystemIds.clear();
        for (const system of next.systems) bubbleSystemIds.add(system.systemId);
        bubbleOriginId = origin;
        stream.send('intel', { bubble: next });

        const byId = new Map(next.recentKills.map((kill) => [kill.killmailId, kill]));
        const newKills: IndexedKill[] = [];
        for (const pending of batch) {
          if (!bubbleSystemIds.has(pending.kill.systemId)) continue;
          if (!pending.announced) stream.send('kill', { kill: pending.kill });
          // The bubble's copy carries resolved pilot names; the pushed copy is
          // the fallback for a kill outside the feed window or its row limit.
          newKills.push(byId.get(pending.kill.killmailId) ?? pending.kill);
        }

        const advisories = evaluateAdvisories(state, {
          bubble: next,
          currentSystemId: origin,
          routeAhead: routeAheadOf(session.chatId, origin),
          newKills,
          now: Date.now(),
        });
        // Hook point for model escalation: `advisories`, `next`, `origin`,
        // `state` and `locale` are everything `shouldEscalateToModel` and a
        // prose composer need. Rule text is published first either way.
        for (const advisory of advisories) {
          publishAdvisory(db, threadId, advisory, locale, stream);
        }
      } catch (error) {
        // A failed build must not lose the kills it was about to judge.
        pendingKills = [...batch, ...pendingKills].slice(-MAX_PENDING_KILLS);
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
      // The shared advisor reference was taken above; without this release a
      // refused attach pins the state as "in use" forever.
      releaseSharedAdvisorState(linked.characterId);
      return reply
        .status(attached.statusCode)
        .header('Retry-After', String(attached.retryAfterSeconds))
        .send({ error: attached.error });
    }

    // Live kills inside the bubble are pushed the moment the index sees them,
    // rather than waiting for the next intel tick.
    // A route planned by the agent must appear on the map without a reload:
    // the assistant reroutes, sets the autopilot and says so in the chat, and
    // the line on screen has to agree with all three.
    const unsubscribeRoute = onActiveRouteChange((laneId, route) => {
      if (stream.closed || laneId !== session.chatId) return;
      stream.send('route', {
        route: route === null ? null : {
          systemIds: route.systemIds,
          jumps: route.jumps,
          mode: route.mode,
          riskWeight: route.riskWeight,
        },
      });
    });

    const unsubscribeKills = onIndexedKill((kill) => {
      if (stream.closed) return;
      const bubbleIsCurrent = bubbleOriginId !== null && bubbleOriginId === currentSystemId;
      if (!bubbleIsCurrent) {
        // Before the first build, or while a jump rebuild is in flight, the
        // system set is unknown or belongs to the system just left. Hold the
        // kill for that build to sort; it is already on its way.
        pendingKills.push({ kill, announced: false });
        if (pendingKills.length > MAX_PENDING_KILLS) pendingKills.splice(0, pendingKills.length - MAX_PENDING_KILLS);
        return;
      }
      if (!bubbleSystemIds.has(kill.systemId)) return;
      pendingKills.push({ kill, announced: true });
      if (pendingKills.length > MAX_PENDING_KILLS) pendingKills.splice(0, pendingKills.length - MAX_PENDING_KILLS);
      stream.send('kill', { kill });
      scheduleKillRefresh();
    });

    const intelTimer = setInterval(() => {
      // A route that ages out while the pilot is watching has to leave the
      // screen. Expiry in the store is lazy, so somebody has to go looking.
      expireStaleRoutes();
      void refresh(lastShipTypeId, 'tick');
    }, config.map.intelRefreshSeconds * 1000);
    intelTimer.unref?.();

    const leaveAudience = joinThreadAudience(threadId, stream);

    stream.onClose(() => {
      leaveAudience();
      clearInterval(intelTimer);
      if (killRefreshTimer !== null) clearTimeout(killRefreshTimer);
      killRefreshTimer = null;
      unsubscribeRoute();
      unsubscribeKills();
      releaseSharedAdvisorState(linked.characterId);
      attached.detach();
    });

    // Sent even when there is no route. The client carries its last drawn line
    // across a reconnect, so silence here would leave a route that expired (or
    // was cleared) while the stream was down on screen forever.
    const current = getActiveRoute(session.chatId);
    stream.send('route', {
      route: current === null ? null : {
        systemIds: current.systemIds,
        jumps: current.jumps,
        mode: current.mode,
        riskWeight: current.riskWeight,
      },
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
  const payload = { advisory, message, escalated: false };
  // Every tab on this thread hears it. The advisor state is shared per pilot,
  // so only the tab whose rebuild ran first gets a non-empty result; without
  // the fan-out the other windows showed nothing until a reload.
  const audience = new Set(threadStreams.get(threadId) ?? []);
  audience.add(stream);
  for (const target of audience) target.send('advisory', payload);
}

/** Open live streams per Perimeter thread, for advisory fan-out. */
const threadStreams = new Map<string, Set<SseStream>>();

function joinThreadAudience(threadId: string, stream: SseStream): () => void {
  const set = threadStreams.get(threadId) ?? new Set<SseStream>();
  set.add(stream);
  threadStreams.set(threadId, set);
  return () => {
    set.delete(stream);
    if (set.size === 0 && threadStreams.get(threadId) === set) threadStreams.delete(threadId);
  };
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
