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

export function rememberRoute(
  chatId: number,
  route: { systemIds: number[]; mode: string; riskWeight: number },
  now = Date.now(),
): void {
  if (route.systemIds.length < 2) {
    activeRoutes.delete(chatId);
    return;
  }
  activeRoutes.set(chatId, {
    systemIds: route.systemIds,
    mode: route.mode,
    riskWeight: route.riskWeight,
    jumps: route.systemIds.length - 1,
    setAtMs: now,
  });
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
  activeRoutes.delete(chatId);
}

export function resetActiveRoutesForTests(): void {
  activeRoutes.clear();
}
