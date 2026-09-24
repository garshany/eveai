/**
 * The whole of New Eden, for the full-cluster map view.
 *
 * The bubble payload is per-viewer by construction: it is centred on one pilot
 * and recomputed for each of them. Serving 8490 systems that way would multiply
 * an already expensive frame by every open tab, which is exactly the mistake
 * that makes "show me the whole map" look impossible.
 *
 * So this module inverts it. Both halves are computed once for everybody:
 *
 *   • the static half — systems, coordinates, security, regions, gate links —
 *     never changes between SDE builds, so it is built once and cached for the
 *     process lifetime, and the client caches it by graph build id.
 *   • the live half — kills per system and a danger band — is one grouped query
 *     over the local kill index, cached for a few seconds and shared by every
 *     viewer. Ten watchers cost the same as one.
 *
 * Payloads are column arrays rather than objects per system: 8490 systems as
 * `{systemId, name, security, ...}` records is roughly a megabyte of repeated
 * key names, and the same data as parallel arrays is a small fraction of that.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { getMapGraphMeta } from '../eve/map-graph.js';
import { getSignatures } from '../eve/eve-scout-client.js';
import { bandFor, type DangerBand } from './danger.js';
import { getKillFeedFreshness, type KillFeedFreshness } from './kill-index.js';

export type UniverseStatic = {
  /** Identifies the SDE build this geometry came from; the client caches on it. */
  buildId: string;
  count: number;
  systemIds: number[];
  names: string[];
  /** Security rounded to two decimals, matching what the client displays. */
  security: number[];
  regionIds: number[];
  regionNames: Record<number, string>;
  x: number[];
  y: number[];
  /** Flat pairs of system ids, two entries per undirected gate link. */
  edges: number[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
};

export type UniverseActivity = {
  at: string;
  windowMinutes: number;
  /** Only systems with something to report; everything else is quiet. */
  systemIds: number[];
  kills1h: number[];
  kills15m: number[];
  npcKills1h: number[];
  valueDestroyed1h: number[];
  /** Kills attributed to a stargate in the window — the camp signal. */
  gateKills1h: number[];
  bands: DangerBand[];
  /** Hourly ESI traffic, carried separately because it is an hour old. */
  baselineJumps: Record<number, number>;
  totals: { activeSystems: number; kills1h: number; campedSystems: number };
};

/**
 * What the whole-map intel route serves: the shared activity rollup plus the
 * kill layer's freshness. A stalled feed leaves every system quiet, which on
 * the whole-map view reads as "all of New Eden is calm" unless it says so.
 */
export type UniverseIntel = UniverseActivity & {
  killFeed: { layer: 'kills' } & KillFeedFreshness;
};

const WINDOW_MS = 60 * 60_000;
const WINDOW_15M_MS = 15 * 60_000;

/**
 * EVE-Scout's Thera/Turnur exits, for the whole cluster rather than one bubble.
 *
 * The bubble builder already fetches these but throws away every link that does
 * not touch the pilot's radius — which on the full map is nearly all of them,
 * and they are the whole point of the layer.
 */
export type UniverseWormhole = {
  signatureId: string;
  /** The K-space side, where a pilot would actually enter. */
  fromSystemId: number;
  /** The Thera/Turnur side. */
  toSystemId: number;
  toSystemName: string;
  whType: string;
  maxShipSize: string;
  remainingHours: number;
};

export type UniverseWormholes = {
  at: string;
  links: UniverseWormhole[];
  /** Null when EVE-Scout answered; the reason when it did not. */
  error: string | null;
};

const WORMHOLE_TTL_MS = 60_000;

let staticCache: UniverseStatic | null = null;
let activityCache: { payload: UniverseActivity; expiresAtMs: number } | null = null;
let wormholeCache: { payload: UniverseWormholes; expiresAtMs: number } | null = null;

export function resetUniverseCachesForTests(): void {
  staticCache = null;
  activityCache = null;
  wormholeCache = null;
}

/**
 * Shared across viewers like the activity rollup: EVE-Scout is one upstream and
 * ten open tabs must not become ten fetches. The client itself is already cached
 * for 300s in `esi_cache`; this shorter cache exists to avoid re-filtering and
 * re-serialising the list on every poll.
 */
export async function getUniverseWormholes(
  db: Db,
  now = Date.now(),
): Promise<UniverseWormholes> {
  if (wormholeCache && wormholeCache.expiresAtMs > now) return wormholeCache.payload;

  const universe = getUniverseStatic(db);
  const placeable = universe === null ? null : new Set(universe.systemIds);

  let payload: UniverseWormholes;
  try {
    const response = await getSignatures(db);
    if (!response.ok) {
      payload = { at: new Date(now).toISOString(), links: [], error: response.error };
    } else {
      const links: UniverseWormhole[] = [];
      for (const signature of response.data) {
        // An expired signature is a hole that has already collapsed.
        const expiresAt = Date.parse(signature.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt <= now) continue;
        if (signature.signature_type && signature.signature_type !== 'wormhole') continue;
        // A link with an end we cannot place would be drawn from the origin of
        // the coordinate system — a line to nowhere, pointing at nothing.
        if (placeable && (!placeable.has(signature.in_system_id) || !placeable.has(signature.out_system_id))) {
          continue;
        }
        links.push({
          signatureId: signature.id,
          fromSystemId: signature.out_system_id,
          toSystemId: signature.in_system_id,
          toSystemName: signature.in_system_name,
          whType: signature.wh_type,
          maxShipSize: signature.max_ship_size,
          remainingHours: signature.remaining_hours,
        });
      }
      payload = { at: new Date(now).toISOString(), links, error: null };
    }
  } catch (error) {
    payload = { at: new Date(now).toISOString(), links: [], error: (error as Error).message };
  }

  wormholeCache = { payload, expiresAtMs: now + WORMHOLE_TTL_MS };
  return payload;
}

/**
 * Static geometry for the whole cluster. Cached for the process lifetime: it
 * only changes when the SDE is reloaded, which rebuilds the graph and restarts
 * this cache with it.
 */
export function getUniverseStatic(db: Db): UniverseStatic | null {
  const meta = getMapGraphMeta(db);
  if (!meta) return null;
  const buildId = `${meta.sdeBuildNumber ?? 'unknown'}:${meta.systemCount}:${meta.edgeCount}`;
  if (staticCache && staticCache.buildId === buildId) return staticCache;

  const rows = db.prepare(`
    SELECT system_id, name, security, region_id, region_name, map_x, map_y
    FROM map_systems
    ORDER BY system_id
  `).all() as Array<{
    system_id: number; name: string; security: number;
    region_id: number | null; region_name: string | null;
    map_x: number; map_y: number;
  }>;

  const systemIds: number[] = [];
  const names: string[] = [];
  const security: number[] = [];
  const regionIds: number[] = [];
  const regionNames: Record<number, string> = {};
  const x: number[] = [];
  const y: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const row of rows) {
    systemIds.push(row.system_id);
    names.push(row.name);
    security.push(row.security);
    regionIds.push(row.region_id ?? 0);
    if (row.region_id !== null && row.region_name && !(row.region_id in regionNames)) {
      regionNames[row.region_id] = row.region_name;
    }
    x.push(row.map_x);
    y.push(row.map_y);
    if (row.map_x < minX) minX = row.map_x;
    if (row.map_x > maxX) maxX = row.map_x;
    if (row.map_y < minY) minY = row.map_y;
    if (row.map_y > maxY) maxY = row.map_y;
  }

  // Each undirected link once: map_edges stores both directions so a BFS never
  // has to union two queries, but sending both would double the payload.
  const edgeRows = db.prepare(
    'SELECT from_system_id, to_system_id FROM map_edges WHERE from_system_id < to_system_id',
  ).all() as Array<{ from_system_id: number; to_system_id: number }>;
  const edges: number[] = [];
  for (const row of edgeRows) {
    edges.push(row.from_system_id, row.to_system_id);
  }

  staticCache = {
    buildId,
    count: systemIds.length,
    systemIds,
    names,
    security,
    regionIds,
    regionNames,
    x,
    y,
    edges,
    bounds: Number.isFinite(minX)
      ? { minX, maxX, minY, maxY }
      : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };
  return staticCache;
}

/**
 * Live activity for every system that has any, computed once and shared.
 *
 * The danger band here is deliberately cheaper than the per-system score the
 * bubble computes: that one is relative to the pilot's hull, and a
 * whole-cluster view has no single pilot. This is the "what is happening"
 * layer, not the "what does it mean for me" layer.
 */
export function getUniverseActivity(db: Db, now = Date.now()): UniverseActivity {
  if (activityCache && activityCache.expiresAtMs > now) return activityCache.payload;

  const rows = db.prepare(`
    SELECT
      system_id,
      SUM(CASE WHEN is_npc = 0 THEN 1 ELSE 0 END) AS pvp_1h,
      SUM(CASE WHEN is_npc = 1 THEN 1 ELSE 0 END) AS npc_1h,
      SUM(CASE WHEN killmail_time_ms >= ? THEN 1 ELSE 0 END) AS kills_15m,
      SUM(total_value) AS value_1h,
      SUM(CASE WHEN gate_id IS NOT NULL AND is_npc = 0 THEN 1 ELSE 0 END) AS gate_1h
    FROM map_kill_events
    WHERE killmail_time_ms >= ?
    GROUP BY system_id
  `).all(now - WINDOW_15M_MS, now - WINDOW_MS) as Array<{
    system_id: number; pvp_1h: number; npc_1h: number; kills_15m: number;
    value_1h: number; gate_1h: number;
  }>;

  const securityBySystem = new Map<number, number>();
  const statics = getUniverseStatic(db);
  if (statics) {
    for (let index = 0; index < statics.systemIds.length; index += 1) {
      securityBySystem.set(statics.systemIds[index]!, statics.security[index]!);
    }
  }

  const systemIds: number[] = [];
  const kills1h: number[] = [];
  const kills15m: number[] = [];
  const npcKills1h: number[] = [];
  const valueDestroyed1h: number[] = [];
  const gateKills1h: number[] = [];
  const bands: DangerBand[] = [];
  let totalKills = 0;
  let campedSystems = 0;

  for (const row of rows) {
    // NPC-only activity is ratting, not danger to a traveller. It is still
    // reported, but it must not colour a system as hostile.
    if (row.pvp_1h === 0 && row.npc_1h === 0) continue;
    systemIds.push(row.system_id);
    kills1h.push(row.pvp_1h);
    kills15m.push(row.kills_15m);
    npcKills1h.push(row.npc_1h);
    valueDestroyed1h.push(Math.round(row.value_1h ?? 0));
    gateKills1h.push(row.gate_1h);
    bands.push(clusterBand(row.pvp_1h, row.gate_1h, securityBySystem.get(row.system_id) ?? 0));
    totalKills += row.pvp_1h;
    if (row.gate_1h >= 2) campedSystems += 1;
  }

  const payload: UniverseActivity = {
    at: new Date(now).toISOString(),
    windowMinutes: 60,
    systemIds,
    kills1h,
    kills15m,
    npcKills1h,
    valueDestroyed1h,
    gateKills1h,
    bands,
    baselineJumps: readBaselineJumps(db, now),
    totals: { activeSystems: systemIds.length, kills1h: totalKills, campedSystems },
  };

  activityCache = {
    payload,
    expiresAtMs: now + config.map.intelRefreshSeconds * 1000,
  };
  return payload;
}

/**
 * The activity rollup is cached and shared, but freshness is evaluated per
 * request so a feed that stalls mid-TTL is reported on the next poll.
 */
export function getUniverseIntel(db: Db, now = Date.now()): UniverseIntel {
  return { ...getUniverseActivity(db, now), killFeed: { layer: 'kills', ...getKillFeedFreshness(now) } };
}

/**
 * Cluster-wide banding from observed activity alone.
 *
 * A camp weighs more than raw volume: two kills on one gate is a traveller's
 * problem, ten kills spread across a system is usually a fight that has nothing
 * to do with passing through.
 */
function clusterBand(pvpKills: number, gateKills: number, security: number): DangerBand {
  if (pvpKills === 0) return 'calm';
  let score = Math.min(0.6, pvpKills / 12);
  if (gateKills >= 2) score += 0.3;
  else if (gateKills === 1) score += 0.1;
  if (security < 0.45) score += 0.1;
  return bandFor(Math.min(1, score));
}

/** Latest hourly traffic bucket, for the traffic channel on the map. */
function readBaselineJumps(db: Db, now: number): Record<number, number> {
  const result: Record<number, number> = {};
  try {
    const latest = db.prepare(
      'SELECT MAX(hour_start_ms) AS hour FROM map_system_hourly',
    ).get() as { hour: number | null } | undefined;
    const hour = latest?.hour;
    // Anything older than a couple of hours is not traffic "now" by any
    // reading, and showing it as such would be the same lie as calling the ESI
    // baseline live.
    if (!hour || now - hour > 3 * 3_600_000) return result;

    const rows = db.prepare(
      'SELECT system_id, ship_jumps FROM map_system_hourly WHERE hour_start_ms = ? AND ship_jumps > 0',
    ).all(hour) as Array<{ system_id: number; ship_jumps: number }>;
    for (const row of rows) result[row.system_id] = row.ship_jumps;
  } catch {
    return result;
  }
  return result;
}
