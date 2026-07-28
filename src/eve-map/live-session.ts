/**
 * Perimeter live sessions — the only thing in this feature that polls ESI on a
 * per-pilot cadence, and therefore the only thing that can hurt a public
 * deployment if it is careless.
 *
 * Four rules hold it in place:
 *   1. A poll exists only while somebody is watching. No stream, no session.
 *   2. One poll per character, however many tabs are attached. Three browser
 *      windows are three subscribers on one timer, not three timers.
 *   3. Failures back off and eventually stop, with the reason handed to the
 *      client instead of a silent freeze.
 *   4. Global and per-user caps refuse new sessions rather than queueing them.
 *
 * Five seconds is not a tuning choice: `/characters/{id}/location/` is cached
 * five seconds by ESI, so a faster poll returns the same body and spends error
 * budget for nothing.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getEveCapabilities, hasFreshCapabilitySnapshot } from '../eve/capabilities.js';
import type { UserContext } from '../auth/user-resolver.js';

export type LiveLocation = {
  characterId: number;
  solarSystemId: number;
  stationId: number | null;
  structureId: number | null;
  shipTypeId: number | null;
  shipName: string | null;
  online: boolean;
  at: string;
};

export type LiveSessionEvent =
  | { type: 'location'; location: LiveLocation; jumped: boolean; previousSystemId: number | null }
  | { type: 'offline'; at: string }
  | { type: 'error'; message: string; fatal: boolean; at: string };

export type LiveSessionSubscriber = (event: LiveSessionEvent) => void;

export type AttachResult =
  | { ok: true; detach: () => void; session: LiveSessionView }
  | { ok: false; statusCode: 429 | 503; error: string; retryAfterSeconds: number };

export type LiveSessionView = {
  characterId: number;
  userId: number;
  subscribers: number;
  lastLocation: LiveLocation | null;
  consecutiveFailures: number;
  startedAt: string;
  lastPollAt: string | null;
  stopped: boolean;
  stopReason: string | null;
};

type Session = {
  characterId: number;
  userId: number;
  ctx: UserContext;
  db: Db;
  subscribers: Set<LiveSessionSubscriber>;
  timer: ReturnType<typeof setInterval> | null;
  lastLocation: LiveLocation | null;
  lastOnlineCheckMs: number;
  online: boolean;
  consecutiveFailures: number;
  backoffUntilMs: number;
  startedAt: string;
  lastPollAt: string | null;
  lastActivityMs: number;
  stopped: boolean;
  stopReason: string | null;
  polling: boolean;
};

const sessions = new Map<number, Session>();
const ONLINE_CHECK_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Attach / detach
// ---------------------------------------------------------------------------

/**
 * Attach a subscriber, creating the poller if this character has none. The
 * returned `detach` is idempotent and stops the poller once the last subscriber
 * leaves — an aborted SSE request must never leave a timer behind.
 */
export function attachLiveSession(
  db: Db,
  ctx: UserContext,
  characterId: number,
  subscriber: LiveSessionSubscriber,
): AttachResult {
  const existing = sessions.get(characterId);

  if (existing) {
    // A character belongs to exactly one account. Refusing here keeps one
    // user's session from leaking another's position through a shared timer.
    if (existing.userId !== ctx.userId) {
      return {
        ok: false,
        statusCode: 503,
        error: 'This character already has a live session owned by another account.',
        retryAfterSeconds: 30,
      };
    }
    existing.subscribers.add(subscriber);
    existing.lastActivityMs = Date.now();
    if (existing.lastLocation) {
      // A late tab gets the current position immediately instead of staring at
      // an empty map until the next tick.
      subscriber({
        type: 'location',
        location: existing.lastLocation,
        jumped: false,
        previousSystemId: null,
      });
    }
    return { ok: true, detach: () => detach(existing, subscriber), session: view(existing) };
  }

  if (sessions.size >= config.map.maxLiveSessions) {
    return {
      ok: false,
      statusCode: 503,
      error: 'The live map is at capacity right now. Try again shortly.',
      retryAfterSeconds: 60,
    };
  }
  let perUser = 0;
  for (const session of sessions.values()) {
    if (session.userId === ctx.userId) perUser += 1;
  }
  if (perUser >= config.map.maxLiveSessionsPerUser) {
    return {
      ok: false,
      statusCode: 429,
      error: 'Too many live map sessions for this account.',
      retryAfterSeconds: 30,
    };
  }

  const session: Session = {
    characterId,
    userId: ctx.userId,
    ctx,
    db,
    subscribers: new Set([subscriber]),
    timer: null,
    lastLocation: null,
    lastOnlineCheckMs: 0,
    online: true,
    consecutiveFailures: 0,
    backoffUntilMs: 0,
    startedAt: new Date().toISOString(),
    lastPollAt: null,
    lastActivityMs: Date.now(),
    stopped: false,
    stopReason: null,
    polling: false,
  };
  sessions.set(characterId, session);

  session.timer = setInterval(
    () => { void poll(session); },
    config.map.locationPollSeconds * 1000,
  );
  session.timer.unref?.();
  void poll(session);

  return { ok: true, detach: () => detach(session, subscriber), session: view(session) };
}

function detach(session: Session, subscriber: LiveSessionSubscriber): void {
  session.subscribers.delete(subscriber);
  if (session.subscribers.size === 0) stop(session, 'no subscribers');
}

function stop(session: Session, reason: string): void {
  if (session.timer) clearInterval(session.timer);
  session.timer = null;
  session.stopped = true;
  session.stopReason = reason;
  sessions.delete(session.characterId);
}

export function getLiveSession(characterId: number): LiveSessionView | null {
  const session = sessions.get(characterId);
  return session ? view(session) : null;
}

export function getLiveSessionStats(): { sessions: number; subscribers: number } {
  let subscribers = 0;
  for (const session of sessions.values()) subscribers += session.subscribers.size;
  return { sessions: sessions.size, subscribers };
}

/** Shutdown drain: stop every poller and tell every subscriber why. */
export function stopAllLiveSessions(reason = 'server shutting down'): number {
  const count = sessions.size;
  for (const session of [...sessions.values()]) {
    emit(session, { type: 'error', message: reason, fatal: true, at: new Date().toISOString() });
    stop(session, reason);
  }
  return count;
}

export function resetLiveSessionsForTests(): void {
  for (const session of [...sessions.values()]) stop(session, 'test reset');
  sessions.clear();
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

async function poll(session: Session): Promise<void> {
  if (session.stopped) return;
  // A slow ESI response must not let a second tick start: overlapping polls
  // would double the request rate exactly when ESI is already struggling.
  if (session.polling) return;
  const now = Date.now();
  if (now < session.backoffUntilMs) return;

  const idleMs = now - session.lastActivityMs;
  if (idleMs > config.map.liveSessionIdleSeconds * 1000) {
    emit(session, {
      type: 'error',
      message: 'Live session idle for too long and was stopped.',
      fatal: true,
      at: new Date(now).toISOString(),
    });
    stop(session, 'idle');
    return;
  }

  session.polling = true;
  try {
    // Private ESI is gated on a fresh capability snapshot (ten-minute TTL) and
    // answers 428 without one. A long-lived poller outlives that window by
    // definition, so it refreshes rather than counting 428s as ESI failures and
    // stopping a session whose scopes were valid all along.
    if (!hasFreshCapabilitySnapshot(session.ctx, session.characterId)) {
      await getEveCapabilities(session.db, 'perimeter live position', session.ctx);
    }
    if (now - session.lastOnlineCheckMs >= ONLINE_CHECK_INTERVAL_MS) {
      session.lastOnlineCheckMs = now;
      const online = await callEsiOperation<{ online?: boolean }>(
        session.db,
        'get_characters_character_id_online',
        {},
        session.ctx,
      );
      if (online.ok) {
        const isOnline = online.data?.online === true;
        if (!isOnline && session.online) {
          session.online = false;
          // The last known position is not deleted, but it stops being
          // presented as current: a frozen dot that claims to be live is worse
          // than an honest "offline".
          emit(session, { type: 'offline', at: new Date(now).toISOString() });
        } else if (isOnline) {
          session.online = true;
        }
      }
    }
    // Between online checks the flag is the only thing that knows. Falling
    // through here used to publish a position with online:true for the next
    // minute, so the UI flipped back from "offline" to "live" while the pilot
    // was still logged out.
    if (!session.online) {
      session.polling = false;
      return;
    }

    const location = await callEsiOperation<{
      solar_system_id?: number; station_id?: number; structure_id?: number;
    }>(session.db, 'get_characters_character_id_location', {}, session.ctx);

    session.lastPollAt = new Date(now).toISOString();

    if (!location.ok) {
      recordFailure(session, location.error ?? `ESI ${location.status}`, now);
      return;
    }
    const solarSystemId = location.data?.solar_system_id;
    if (typeof solarSystemId !== 'number') {
      recordFailure(session, 'ESI returned a location without a solar system.', now);
      return;
    }

    let shipTypeId: number | null = session.lastLocation?.shipTypeId ?? null;
    let shipName: string | null = session.lastLocation?.shipName ?? null;
    const ship = await callEsiOperation<{ ship_type_id?: number; ship_name?: string }>(
      session.db,
      'get_characters_character_id_ship',
      {},
      session.ctx,
    );
    if (ship.ok) {
      shipTypeId = typeof ship.data?.ship_type_id === 'number' ? ship.data.ship_type_id : shipTypeId;
      shipName = typeof ship.data?.ship_name === 'string' ? ship.data.ship_name : shipName;
    }

    session.consecutiveFailures = 0;
    session.backoffUntilMs = 0;

    const previousSystemId = session.lastLocation?.solarSystemId ?? null;
    const next: LiveLocation = {
      characterId: session.characterId,
      solarSystemId,
      stationId: typeof location.data?.station_id === 'number' ? location.data.station_id : null,
      structureId: typeof location.data?.structure_id === 'number' ? location.data.structure_id : null,
      shipTypeId,
      shipName,
      online: true,
      at: new Date(now).toISOString(),
    };
    session.lastLocation = next;
    // Only a jump renews the lease. Renewing on every successful poll meant a
    // healthy poller extended its own deadline forever, so a viewer whose
    // socket stayed open but who was long gone held a global slot indefinitely.
    if (previousSystemId !== null && previousSystemId !== solarSystemId) {
      session.lastActivityMs = now;
    }

    emit(session, {
      type: 'location',
      location: next,
      jumped: previousSystemId !== null && previousSystemId !== solarSystemId,
      previousSystemId,
    });
  } catch (error) {
    recordFailure(session, (error as Error).message, now);
  } finally {
    session.polling = false;
  }
}

function recordFailure(session: Session, message: string, now: number): void {
  session.consecutiveFailures += 1;
  const fatal = session.consecutiveFailures >= config.map.liveSessionMaxFailures;
  if (fatal) {
    emit(session, {
      type: 'error',
      message: `Live position stopped after ${session.consecutiveFailures} consecutive ESI failures: ${message}`,
      fatal: true,
      at: new Date(now).toISOString(),
    });
    stop(session, 'esi failures');
    return;
  }
  // Exponential, capped at a minute: a struggling ESI must not be hammered,
  // and a pilot must not wait longer than a minute for recovery.
  const backoffMs = Math.min(60_000, config.map.locationPollSeconds * 1000 * 2 ** session.consecutiveFailures);
  session.backoffUntilMs = now + backoffMs;
  emit(session, {
    type: 'error',
    message,
    fatal: false,
    at: new Date(now).toISOString(),
  });
}

function emit(session: Session, event: LiveSessionEvent): void {
  for (const subscriber of session.subscribers) {
    try {
      subscriber(event);
    } catch (error) {
      console.warn('[map-live] subscriber failed: %s', (error as Error).message);
    }
  }
}

function view(session: Session): LiveSessionView {
  return {
    characterId: session.characterId,
    userId: session.userId,
    subscribers: session.subscribers.size,
    lastLocation: session.lastLocation,
    consecutiveFailures: session.consecutiveFailures,
    startedAt: session.startedAt,
    lastPollAt: session.lastPollAt,
    stopped: session.stopped,
    stopReason: session.stopReason,
  };
}
