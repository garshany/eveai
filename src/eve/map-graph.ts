/**
 * Perimeter map graph — the static half of the live map.
 *
 * Everything here is derived from the local SDE and is rebuildable: systems
 * with rendering coordinates, the undirected stargate graph, a jump-distance
 * BFS ("the bubble"), and a risk-weighted Dijkstra used by the route planner.
 *
 * The adjacency list is held in memory after the first read. New Eden is ~8k
 * systems and ~14k gate links, so the whole graph costs a couple of megabytes
 * and turns every bubble expansion into pointer chasing instead of SQL. The
 * cache is invalidated explicitly by `buildMapGraph`.
 */

import type { Db } from '../db/sqlite.js';

export type GeometrySource = 'position2D' | 'position3D' | 'unknown';

export type MapSystem = {
  systemId: number;
  name: string;
  constellationId: number | null;
  regionId: number | null;
  regionName: string | null;
  security: number;
  securityClass: string | null;
  mapX: number;
  mapY: number;
  whClass: number | null;
};

export type MapGraphMeta = {
  builtAt: string;
  sdeBuildNumber: string | null;
  systemCount: number;
  edgeCount: number;
  geometrySource: GeometrySource;
};

export type BubbleNode = { systemId: number; jumps: number };

export type Bubble = {
  originId: number;
  /** Radius actually covered, which is lower than `requestedRadius` when capped. */
  radius: number;
  requestedRadius: number;
  nodes: BubbleNode[];
  edges: Array<[number, number]>;
  /** True when the node cap stopped the expansion before `requestedRadius`. */
  truncated: boolean;
};

export type RouteMode = 'shortest' | 'secure' | 'insecure';

export type RouteHop = {
  systemId: number;
  /** Cost charged for entering this system; the origin hop is always 0. */
  cost: number;
  /** Labelled cost terms, so a route can always explain itself. */
  terms: Array<{ label: string; value: number }>;
};

export type RiskRoute = {
  ok: boolean;
  mode: RouteMode;
  riskWeight: number;
  systemIds: number[];
  hops: RouteHop[];
  jumps: number;
  totalCost: number;
  error: string | null;
};

export type RouteOptions = {
  mode?: RouteMode;
  /** Multiplier on the 0..1 danger score. 0 reduces the search to plain BFS. */
  riskWeight?: number;
  avoid?: Iterable<number>;
  dangerOf?: (systemId: number) => number;
  /** Extra traversable links (wormholes), applied in both directions. */
  extraEdges?: Array<[number, number]>;
};

/** Charged once per hop that leaves the security band the mode prefers. */
const MODE_PENALTY = 50;
const HIGHSEC_FLOOR = 0.45;

// ---------------------------------------------------------------------------
// In-memory graph cache
// ---------------------------------------------------------------------------

export type MapGate = {
  gateId: number;
  systemId: number;
  destinationSystemId: number | null;
  x: number;
  y: number;
  z: number;
};

/**
 * "On the gate" in EVE means gate grid — a couple of hundred kilometres. Kills
 * further out are something else happening in the same system, and counting
 * them as gate kills is what turns a camp signal into noise.
 */
export const GATE_PROXIMITY_M = 200_000;

type GraphCache = {
  adjacency: Map<number, number[]>;
  systems: Map<number, MapSystem>;
  gatesBySystem: Map<number, MapGate[]>;
};

let cache: GraphCache | null = null;

export function invalidateMapGraphCache(): void {
  cache = null;
}

function loadGraph(db: Db): GraphCache {
  if (cache) return cache;
  const systems = new Map<number, MapSystem>();
  const systemRows = db.prepare(`
    SELECT system_id, name, constellation_id, region_id, region_name,
           security, security_class, map_x, map_y, wh_class
    FROM map_systems
  `).all() as Array<{
    system_id: number;
    name: string;
    constellation_id: number | null;
    region_id: number | null;
    region_name: string | null;
    security: number;
    security_class: string | null;
    map_x: number;
    map_y: number;
    wh_class: number | null;
  }>;
  for (const row of systemRows) {
    systems.set(row.system_id, {
      systemId: row.system_id,
      name: row.name,
      constellationId: row.constellation_id,
      regionId: row.region_id,
      regionName: row.region_name,
      security: row.security,
      securityClass: row.security_class,
      mapX: row.map_x,
      mapY: row.map_y,
      whClass: row.wh_class,
    });
  }

  const adjacency = new Map<number, number[]>();
  const edgeRows = db.prepare(
    'SELECT from_system_id, to_system_id FROM map_edges',
  ).all() as Array<{ from_system_id: number; to_system_id: number }>;
  for (const row of edgeRows) {
    const list = adjacency.get(row.from_system_id);
    if (list) list.push(row.to_system_id);
    else adjacency.set(row.from_system_id, [row.to_system_id]);
  }

  const gatesBySystem = new Map<number, MapGate[]>();
  const gateRows = db.prepare(
    'SELECT gate_id, system_id, destination_system_id, x, y, z FROM map_gates',
  ).all() as Array<{
    gate_id: number;
    system_id: number;
    destination_system_id: number | null;
    x: number;
    y: number;
    z: number;
  }>;
  for (const row of gateRows) {
    const gate: MapGate = {
      gateId: row.gate_id,
      systemId: row.system_id,
      destinationSystemId: row.destination_system_id,
      x: row.x,
      y: row.y,
      z: row.z,
    };
    const list = gatesBySystem.get(row.system_id);
    if (list) list.push(gate);
    else gatesBySystem.set(row.system_id, [gate]);
  }

  cache = { adjacency, systems, gatesBySystem };
  return cache;
}

export function getSystemGates(db: Db, systemId: number): MapGate[] {
  return loadGraph(db).gatesBySystem.get(systemId) ?? [];
}

/**
 * The stargate a kill happened on, or null when it happened somewhere else in
 * the system. Called once per ingested killmail, so it walks the handful of
 * gates in one system rather than any index — a system has single digits of
 * them.
 */
export function nearestGate(
  db: Db,
  systemId: number,
  position: { x: number; y: number; z: number },
  radiusM = GATE_PROXIMITY_M,
): MapGate | null {
  let best: MapGate | null = null;
  let bestDistance = Infinity;
  for (const gate of getSystemGates(db, systemId)) {
    const dx = gate.x - position.x;
    const dy = gate.y - position.y;
    const dz = gate.z - position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = gate;
    }
  }
  return best !== null && bestDistance <= radiusM ? best : null;
}

export function getMapSystem(db: Db, systemId: number): MapSystem | null {
  return loadGraph(db).systems.get(systemId) ?? null;
}

export function getMapSystems(db: Db, systemIds: Iterable<number>): Map<number, MapSystem> {
  const graph = loadGraph(db);
  const result = new Map<number, MapSystem>();
  for (const id of systemIds) {
    const system = graph.systems.get(id);
    if (system) result.set(id, system);
  }
  return result;
}

export function getMapGraphMeta(db: Db): MapGraphMeta | null {
  const row = db.prepare(`
    SELECT built_at, sde_build_number, system_count, edge_count, geometry_source
    FROM map_graph_meta WHERE id = 1
  `).get() as {
    built_at: string;
    sde_build_number: string | null;
    system_count: number;
    edge_count: number;
    geometry_source: string;
  } | undefined;
  if (!row) return null;
  return {
    builtAt: row.built_at,
    sdeBuildNumber: row.sde_build_number,
    systemCount: row.system_count,
    edgeCount: row.edge_count,
    geometrySource: isGeometrySource(row.geometry_source) ? row.geometry_source : 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export type BuildResult = {
  rebuilt: boolean;
  reason: 'up_to_date' | 'missing' | 'sde_changed' | 'forced';
  meta: MapGraphMeta;
};

export class MapGraphBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapGraphBuildError';
  }
}

/**
 * Rebuild `map_systems` / `map_edges` from the SDE when they are missing or the
 * loaded SDE build changed. A build that cannot resolve rendering coordinates
 * throws instead of writing a map with every system stacked at the origin —
 * a visibly broken map is far worse than a startup failure that names the
 * missing field.
 */
export function buildMapGraph(db: Db, options: { force?: boolean } = {}): BuildResult {
  const sdeBuild = readSdeBuildNumber(db);
  const existing = getMapGraphMeta(db);
  if (!options.force && existing && existing.systemCount > 0) {
    if (existing.sdeBuildNumber === sdeBuild) {
      return { rebuilt: false, reason: 'up_to_date', meta: existing };
    }
  }

  const systemRows = db.prepare(`
    SELECT s.system_id, s.name, s.constellation_id, s.data_json,
           c.region_id AS region_id, r.name AS region_name
    FROM sde_systems s
    LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    LEFT JOIN sde_regions r ON r.region_id = c.region_id
  `).all() as Array<{
    system_id: number;
    name: string;
    constellation_id: number | null;
    data_json: string;
    region_id: number | null;
    region_name: string | null;
  }>;

  if (systemRows.length === 0) {
    throw new MapGraphBuildError(
      'sde_systems is empty. Run `npm run setup` to download and load the SDE before building the map graph.',
    );
  }

  const prepared: Array<{
    system: Omit<MapSystem, 'regionName'> & { regionName: string | null };
    x: number;
    y: number;
    z: number;
    factionId: number | null;
    source: GeometrySource;
  }> = [];
  let with2d = 0;
  let with3d = 0;

  for (const row of systemRows) {
    const raw = parseJsonRecord(row.data_json);
    const geometry = readGeometry(raw);
    if (!geometry) continue;
    if (geometry.source === 'position2D') with2d += 1;
    else with3d += 1;
    prepared.push({
      system: {
        systemId: row.system_id,
        name: row.name,
        constellationId: row.constellation_id,
        regionId: row.region_id,
        regionName: row.region_name,
        security: readSecurity(raw),
        securityClass: readString(raw.securityClass),
        mapX: geometry.mapX,
        mapY: geometry.mapY,
        whClass: readNumber(raw.wormholeClassID),
      },
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      factionId: readNumber(raw.factionID) ?? readNumber(raw.faction_id),
      source: geometry.source,
    });
  }

  if (prepared.length === 0) {
    throw new MapGraphBuildError(
      'No solar system in sde_systems carries usable coordinates. '
      + 'Expected `position2D` {x,y} or `position` {x,y,z} inside data_json. '
      + 'Re-run `npm run setup` against a current SDE export.',
    );
  }
  // A partial geometry set means half the map would be invisible. Refuse rather
  // than draw a map that silently omits systems.
  const coverage = prepared.length / systemRows.length;
  if (coverage < 0.9) {
    throw new MapGraphBuildError(
      `Only ${prepared.length} of ${systemRows.length} systems carry coordinates `
      + `(${Math.round(coverage * 100)}%). Refusing to build a partial map graph.`,
    );
  }

  const geometrySource: GeometrySource = with2d >= with3d ? 'position2D' : 'position3D';
  const known = new Set(prepared.map((entry) => entry.system.systemId));

  const gateRows = db.prepare(`
    SELECT stargate_id, system_id, destination_system_id, data_json
    FROM sde_stargates
    WHERE system_id IS NOT NULL AND destination_system_id IS NOT NULL
  `).all() as Array<{
    stargate_id: number;
    system_id: number;
    destination_system_id: number;
    data_json: string;
  }>;

  const edges = new Set<string>();
  const gates: MapGate[] = [];
  for (const row of gateRows) {
    if (row.system_id === row.destination_system_id) continue;
    if (!known.has(row.system_id) || !known.has(row.destination_system_id)) continue;
    edges.add(`${row.system_id}:${row.destination_system_id}`);
    edges.add(`${row.destination_system_id}:${row.system_id}`);

    // A gate without a position cannot anchor a camp, but it is still a link:
    // the edge is kept, only the geometry row is skipped.
    const position = readVector(parseJsonRecord(row.data_json).position);
    if (!position) continue;
    gates.push({
      gateId: row.stargate_id,
      systemId: row.system_id,
      destinationSystemId: row.destination_system_id,
      x: position.x,
      y: position.y,
      z: position.z,
    });
  }
  if (edges.size === 0) {
    throw new MapGraphBuildError(
      'sde_stargates produced no gate links. The map graph would have no connections.',
    );
  }

  const builtAt = new Date().toISOString();
  const write = db.transaction(() => {
    db.exec('DELETE FROM map_gates');
    db.exec('DELETE FROM map_edges');
    db.exec('DELETE FROM map_systems');
    const insertSystem = db.prepare(`
      INSERT INTO map_systems (
        system_id, name, constellation_id, region_id, region_name,
        security, security_class, x, y, z, map_x, map_y,
        faction_id, wh_class, geometry_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of prepared) {
      insertSystem.run(
        entry.system.systemId,
        entry.system.name,
        entry.system.constellationId,
        entry.system.regionId,
        entry.system.regionName,
        entry.system.security,
        entry.system.securityClass,
        entry.x,
        entry.y,
        entry.z,
        entry.system.mapX,
        entry.system.mapY,
        entry.factionId,
        entry.system.whClass,
        entry.source,
      );
    }
    const insertEdge = db.prepare(
      'INSERT OR IGNORE INTO map_edges (from_system_id, to_system_id) VALUES (?, ?)',
    );
    for (const key of edges) {
      const separator = key.indexOf(':');
      insertEdge.run(Number(key.slice(0, separator)), Number(key.slice(separator + 1)));
    }
    const insertGate = db.prepare(`
      INSERT OR REPLACE INTO map_gates (gate_id, system_id, destination_system_id, x, y, z)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const gate of gates) {
      insertGate.run(gate.gateId, gate.systemId, gate.destinationSystemId, gate.x, gate.y, gate.z);
    }
    db.prepare(`
      INSERT INTO map_graph_meta (id, built_at, sde_build_number, system_count, edge_count, geometry_source)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        built_at = excluded.built_at,
        sde_build_number = excluded.sde_build_number,
        system_count = excluded.system_count,
        edge_count = excluded.edge_count,
        geometry_source = excluded.geometry_source
    `).run(builtAt, sdeBuild, prepared.length, edges.size, geometrySource);
  });
  write();
  invalidateMapGraphCache();

  return {
    rebuilt: true,
    reason: options.force ? 'forced' : existing ? 'sde_changed' : 'missing',
    meta: {
      builtAt,
      sdeBuildNumber: sdeBuild,
      systemCount: prepared.length,
      edgeCount: edges.size,
      geometrySource,
    },
  };
}

// ---------------------------------------------------------------------------
// Bubble
// ---------------------------------------------------------------------------

/**
 * Breadth-first expansion by jump distance. `maxNodes` is a hard ceiling: a
 * ten-jump bubble in highsec can reach well over a thousand systems, and a map
 * that quietly drops half of them is worse than one that says how far it got.
 * Expansion always completes the ring it started, so every returned node has a
 * correct jump distance.
 */
export function bubbleFrom(
  db: Db,
  originId: number,
  radius: number,
  maxNodes: number,
): Bubble {
  const graph = loadGraph(db);
  const requestedRadius = Math.max(0, Math.floor(radius));
  const cap = Math.max(1, Math.floor(maxNodes));

  if (!graph.systems.has(originId)) {
    return {
      originId,
      radius: 0,
      requestedRadius,
      nodes: [],
      edges: [],
      truncated: false,
    };
  }

  const distance = new Map<number, number>([[originId, 0]]);
  let frontier = [originId];
  let reached = 0;
  let truncated = false;

  for (let depth = 1; depth <= requestedRadius && frontier.length > 0; depth += 1) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const neighbour of graph.adjacency.get(current) ?? []) {
        if (distance.has(neighbour)) continue;
        distance.set(neighbour, depth);
        next.push(neighbour);
      }
    }
    if (next.length === 0) break;
    // The ring is admitted whole or not at all, so no node ends up with a
    // distance that depends on iteration order within its level.
    if (distance.size > cap) {
      for (const id of next) distance.delete(id);
      truncated = true;
      break;
    }
    reached = depth;
    frontier = next;
  }

  const nodes: BubbleNode[] = [];
  for (const [systemId, jumps] of distance) nodes.push({ systemId, jumps });
  nodes.sort((a, b) => a.jumps - b.jumps || a.systemId - b.systemId);

  const edges: Array<[number, number]> = [];
  for (const { systemId } of nodes) {
    for (const neighbour of graph.adjacency.get(systemId) ?? []) {
      // Emit each undirected link once.
      if (neighbour <= systemId) continue;
      if (!distance.has(neighbour)) continue;
      edges.push([systemId, neighbour]);
    }
  }

  return { originId, radius: reached, requestedRadius, nodes, edges, truncated };
}

/** Jump distance between two systems, or null when unreachable within `limit`. */
export function jumpDistance(db: Db, fromId: number, toId: number, limit = 50): number | null {
  if (fromId === toId) return 0;
  const graph = loadGraph(db);
  if (!graph.systems.has(fromId) || !graph.systems.has(toId)) return null;
  const seen = new Set([fromId]);
  let frontier = [fromId];
  for (let depth = 1; depth <= limit; depth += 1) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const neighbour of graph.adjacency.get(current) ?? []) {
        if (seen.has(neighbour)) continue;
        if (neighbour === toId) return depth;
        seen.add(neighbour);
        next.push(neighbour);
      }
    }
    if (next.length === 0) return null;
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Risk-weighted routing
// ---------------------------------------------------------------------------

/**
 * Dijkstra over the gate graph where entering a system costs one jump plus a
 * risk surcharge. With `riskWeight === 0` and mode `shortest` this degenerates
 * to a shortest-jump search, which is the property the tests pin.
 *
 * Security preference is a penalty rather than a ban: a pilot asking for a
 * secure route to a nullsec station still needs a route, and ESI's own `secure`
 * flag behaves the same way.
 */
export function routeWithRisk(
  db: Db,
  originId: number,
  destinationId: number,
  options: RouteOptions = {},
): RiskRoute {
  const mode = options.mode ?? 'shortest';
  const riskWeight = Math.max(0, options.riskWeight ?? 0);
  const dangerOf = options.dangerOf ?? (() => 0);
  const avoid = new Set(options.avoid ?? []);
  const graph = loadGraph(db);

  const empty = (error: string): RiskRoute => ({
    ok: false, mode, riskWeight, systemIds: [], hops: [], jumps: 0, totalCost: 0, error,
  });

  if (!graph.systems.has(originId)) return empty(`Unknown origin system ${originId}.`);
  if (!graph.systems.has(destinationId)) return empty(`Unknown destination system ${destinationId}.`);
  if (avoid.has(destinationId)) return empty('The destination is in the avoid list.');
  if (originId === destinationId) {
    return {
      ok: true,
      mode,
      riskWeight,
      systemIds: [originId],
      hops: [{ systemId: originId, cost: 0, terms: [] }],
      jumps: 0,
      totalCost: 0,
      error: null,
    };
  }

  const extra = new Map<number, number[]>();
  for (const [from, to] of options.extraEdges ?? []) {
    if (!graph.systems.has(from) || !graph.systems.has(to)) continue;
    pushEdge(extra, from, to);
    pushEdge(extra, to, from);
  }

  const best = new Map<number, number>([[originId, 0]]);
  const previous = new Map<number, number>();
  const settled = new Set<number>();
  // New Eden is small enough that a linear-scan frontier beats the constant
  // factor of a heap; the whole search touches at most ~8k systems.
  const queue = new Map<number, number>([[originId, 0]]);

  while (queue.size > 0) {
    let currentId = -1;
    let currentCost = Infinity;
    for (const [id, cost] of queue) {
      if (cost < currentCost) {
        currentCost = cost;
        currentId = id;
      }
    }
    queue.delete(currentId);
    if (currentId === destinationId) break;
    if (settled.has(currentId)) continue;
    settled.add(currentId);

    const neighbours = graph.adjacency.get(currentId) ?? [];
    const extraNeighbours = extra.get(currentId) ?? [];
    for (const neighbour of [...neighbours, ...extraNeighbours]) {
      if (settled.has(neighbour) || avoid.has(neighbour)) continue;
      const cost = currentCost + hopCost(graph, neighbour, mode, riskWeight, dangerOf).cost;
      if (cost < (best.get(neighbour) ?? Infinity)) {
        best.set(neighbour, cost);
        previous.set(neighbour, currentId);
        queue.set(neighbour, cost);
      }
    }
  }

  if (!best.has(destinationId)) {
    return empty('No gate route connects these systems.');
  }

  const systemIds: number[] = [];
  for (let cursor: number | undefined = destinationId; cursor !== undefined; cursor = previous.get(cursor)) {
    systemIds.push(cursor);
    if (cursor === originId) break;
  }
  systemIds.reverse();

  const hops: RouteHop[] = systemIds.map((systemId, index) => {
    if (index === 0) return { systemId, cost: 0, terms: [] };
    const breakdown = hopCost(graph, systemId, mode, riskWeight, dangerOf);
    return { systemId, cost: breakdown.cost, terms: breakdown.terms };
  });

  return {
    ok: true,
    mode,
    riskWeight,
    systemIds,
    hops,
    jumps: systemIds.length - 1,
    totalCost: best.get(destinationId) ?? 0,
    error: null,
  };
}

function hopCost(
  graph: GraphCache,
  systemId: number,
  mode: RouteMode,
  riskWeight: number,
  dangerOf: (systemId: number) => number,
): { cost: number; terms: Array<{ label: string; value: number }> } {
  const terms: Array<{ label: string; value: number }> = [{ label: 'jump', value: 1 }];
  let cost = 1;

  if (riskWeight > 0) {
    const danger = clamp01(dangerOf(systemId));
    if (danger > 0) {
      const value = riskWeight * danger;
      cost += value;
      terms.push({ label: 'danger', value });
    }
  }

  const security = graph.systems.get(systemId)?.security ?? 0;
  if (mode === 'secure' && security < HIGHSEC_FLOOR) {
    cost += MODE_PENALTY;
    terms.push({ label: 'leaves_highsec', value: MODE_PENALTY });
  } else if (mode === 'insecure' && security >= HIGHSEC_FLOOR) {
    cost += MODE_PENALTY;
    terms.push({ label: 'enters_highsec', value: MODE_PENALTY });
  }

  return { cost, terms };
}

function pushEdge(map: Map<number, number[]>, from: number, to: number): void {
  const list = map.get(from);
  if (list) list.push(to);
  else map.set(from, [to]);
}

// ---------------------------------------------------------------------------
// SDE record readers
// ---------------------------------------------------------------------------

type Geometry = { x: number; y: number; z: number; mapX: number; mapY: number; source: GeometrySource };

/**
 * `position2D` is CCP's own flattened map layout and is preferred when present.
 * Otherwise the 3D position is projected as (x, -z): EVE uses a left-handed
 * system with +X east and +Z north, so negating Z puts north at the top.
 */
function readGeometry(raw: Record<string, unknown>): Geometry | null {
  const position = readVector(raw.position) ?? readVector(raw.center);
  const flat = readVector(raw.position2D);
  if (flat) {
    return {
      x: position?.x ?? flat.x,
      y: position?.y ?? 0,
      z: position?.z ?? flat.y,
      mapX: flat.x,
      mapY: flat.y,
      source: 'position2D',
    };
  }
  if (position) {
    return {
      x: position.x,
      y: position.y,
      z: position.z,
      mapX: position.x,
      mapY: -position.z,
      source: 'position3D',
    };
  }
  // Legacy exports keep flat x/y/z on the record itself.
  const x = readNumber(raw.x);
  const y = readNumber(raw.y);
  const z = readNumber(raw.z);
  if (x !== null && z !== null) {
    return { x, y: y ?? 0, z, mapX: x, mapY: -z, source: 'position3D' };
  }
  return null;
}

function readVector(value: unknown): { x: number; y: number; z: number } | null {
  if (Array.isArray(value)) {
    const [x, y, z] = value;
    if (typeof x === 'number' && typeof y === 'number') {
      return { x, y, z: typeof z === 'number' ? z : y };
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const x = readNumber(value.x);
  const y = readNumber(value.y);
  const z = readNumber(value.z);
  if (x === null) return null;
  // position2D carries only x/y; callers treat y as the second map axis.
  if (z === null) return y === null ? null : { x, y, z: y };
  return { x, y: y ?? 0, z };
}

function readSecurity(raw: Record<string, unknown>): number {
  const value = readNumber(raw.securityStatus) ?? readNumber(raw.security);
  if (value === null) return 0;
  // Two decimals is what the client and every third-party map display, and it
  // keeps the highsec boundary from wobbling on 0.4499999.
  return Math.round(value * 100) / 100;
}

function readSdeBuildNumber(db: Db): string | null {
  try {
    const row = db.prepare('SELECT build_number FROM sde_meta LIMIT 1').get() as
      { build_number: number | string | null } | undefined;
    if (!row || row.build_number === null || row.build_number === undefined) return null;
    return String(row.build_number);
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isGeometrySource(value: string): value is GeometrySource {
  return value === 'position2D' || value === 'position3D' || value === 'unknown';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
