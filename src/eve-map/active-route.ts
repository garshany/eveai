/**
 * The route the pilot is actually flying, remembered per chat lane.
 *
 * It lives here rather than inside the HTTP layer because two very different
 * readers need it: the advisory rules on the live stream, and the agent's own
 * tools. When only the stream could see it, the pilot planned a route on the
 * map, asked "что по моему маршруту?", and the agent answered that no route
 * existed — which is true of ESI waypoints and useless to the person looking
 * at the route drawn on their screen.
 */

export type ActiveRoute = {
  systemIds: number[];
  mode: string;
  riskWeight: number;
  jumps: number;
  setAtMs: number;
};

/** A route nobody has refreshed in this long is no longer what they are flying. */
export const ACTIVE_ROUTE_TTL_MS = 2 * 60 * 60_000;

const activeRoutes = new Map<number, ActiveRoute>();

/**
 * Notified whenever the route for a lane changes, so an open map can redraw
 * without a reload.
 *
 * Without this the agent could plan a route, set the autopilot, describe it in
 * the chat — and the line on the map would still show the old one, because the
 * map only ever learned about routes it had planned itself.
 */
type RouteListener = (chatId: number, route: ActiveRoute | null) => void;
const listeners = new Set<RouteListener>();

export function onActiveRouteChange(listener: RouteListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(chatId: number, route: ActiveRoute | null): void {
  for (const listener of listeners) {
    try {
      listener(chatId, route);
    } catch (error) {
      console.warn('[map-route] listener failed: %s', (error as Error).message);
    }
  }
}

export function rememberRoute(
  chatId: number,
  route: { systemIds: number[]; mode: string; riskWeight: number },
  now = Date.now(),
): void {
  if (route.systemIds.length < 2) {
    activeRoutes.delete(chatId);
    publish(chatId, null);
    return;
  }
  const entry: ActiveRoute = {
    systemIds: route.systemIds,
    mode: route.mode,
    riskWeight: route.riskWeight,
    jumps: route.systemIds.length - 1,
    setAtMs: now,
  };
  activeRoutes.set(chatId, entry);
  publish(chatId, entry);
}

export function getActiveRoute(chatId: number, now = Date.now()): ActiveRoute | null {
  const entry = activeRoutes.get(chatId);
  if (!entry) return null;
  if (now - entry.setAtMs > ACTIVE_ROUTE_TTL_MS) {
    activeRoutes.delete(chatId);
    return null;
  }
  return entry;
}

/**
 * Drop every route whose TTL has run out, and tell the map about each one.
 *
 * Expiry used to happen only inside getActiveRoute: the entry vanished for the
 * next reader, but nobody told the open stream, so a route that aged out
 * mid-session stayed drawn on screen until the pilot reloaded the page.
 *
 * The lazy delete in getActiveRoute stays as a second line of defence and stays
 * silent — publishing from a getter would make an agent answering "что вокруг
 * меня" write SSE frames from inside the assembly of a tool response.
 *
 * Returns how many lanes were expired, so a caller can log a sweep that did
 * something. Deleting during iteration is safe; a listener that plans a route
 * for another lane mid-sweep is simply picked up on the next tick.
 */
export function expireStaleRoutes(now = Date.now()): number {
  let expired = 0;
  for (const [chatId, entry] of activeRoutes) {
    if (now - entry.setAtMs <= ACTIVE_ROUTE_TTL_MS) continue;
    activeRoutes.delete(chatId);
    publish(chatId, null);
    expired += 1;
  }
  return expired;
}

/** The part of the route still ahead of the pilot. */
export function routeAheadOf(chatId: number, currentSystemId: number, now = Date.now()): number[] {
  const entry = getActiveRoute(chatId, now);
  if (!entry) return [];
  const index = entry.systemIds.indexOf(currentSystemId);
  // Off the planned route entirely: better to say nothing about it than to warn
  // about hops the pilot is no longer heading for.
  return index < 0 ? [] : entry.systemIds.slice(index + 1);
}

export function clearActiveRoute(chatId: number): void {
  publish(chatId, null);
  activeRoutes.delete(chatId);
}

export function resetActiveRoutesForTests(): void {
  listeners.clear();
  activeRoutes.clear();
}
