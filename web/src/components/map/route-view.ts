/**
 * Which parts of a route a bubble view can honestly draw.
 *
 * The bubble holds only the systems within the pilot's radius; a route does not
 * stop at that edge. The renderer used to walk the route and simply skip the
 * systems it could not place — while continuing the same path — so a route
 * leaving the bubble was drawn as a straight line between two systems that
 * share no gate. That is not a shortened route, it is an invented one.
 *
 * Pure functions, extracted so the property can be pinned by a test rather than
 * checked by eye, the same way universe-view.ts was.
 *
 * Adjacency is safe by construction here: a route is a path along gates, so two
 * consecutive route systems that are both in the bubble really are neighbours.
 * Only a gap can lie.
 */

/**
 * Contiguous stretches of the route the view can place, in travel order.
 *
 * A route that leaves the bubble and comes back yields two runs, never one.
 * Runs of a single system are returned as-is; drawing them is the caller's
 * decision (a lone system is a dot, not a line).
 */
export function splitRouteRuns(
  routeSystemIds: number[],
  present: (systemId: number) => boolean,
): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  for (const systemId of routeSystemIds) {
    if (present(systemId)) {
      current.push(systemId);
      continue;
    }
    if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Where the drawn line stops because the route continues off-view.
 *
 * `exits` are systems whose *next* hop cannot be placed, `entries` are systems
 * whose *previous* hop cannot be placed. Both are needed: a route can enter the
 * bubble from outside as easily as it can leave.
 */
export function routeBreaks(
  routeSystemIds: number[],
  present: (systemId: number) => boolean,
): { exits: number[]; entries: number[] } {
  const exits: number[] = [];
  const entries: number[] = [];
  for (let index = 0; index < routeSystemIds.length; index += 1) {
    const systemId = routeSystemIds[index]!;
    if (!present(systemId)) continue;
    const next = routeSystemIds[index + 1];
    const previous = routeSystemIds[index - 1];
    if (next !== undefined && !present(next)) exits.push(systemId);
    if (previous !== undefined && !present(previous)) entries.push(systemId);
  }
  return { exits, entries };
}

/**
 * How many of the route's jumps this view cannot show.
 *
 * Counted as hops, not systems, because that is the unit the pilot thinks in
 * and the number the chip puts on screen. A hop is hidden when either of its
 * two endpoints is missing.
 */
export function hiddenHopCount(
  routeSystemIds: number[],
  present: (systemId: number) => boolean,
): number {
  let hidden = 0;
  for (let index = 1; index < routeSystemIds.length; index += 1) {
    const from = routeSystemIds[index - 1]!;
    const to = routeSystemIds[index]!;
    if (!present(from) || !present(to)) hidden += 1;
  }
  return hidden;
}
