/**
 * Perimeter bubble assembly — the payload behind one frame of the live map.
 *
 * Topology comes from the local graph, live activity from the local kill index,
 * and only two slow, shared, hourly things go out to the network: the ESI
 * baseline and sovereignty. Everything per-viewer is local, which is what keeps
 * a five-second refresh affordable for a public deployment.
 *
 * Every outbound layer degrades independently: a failed sovereignty fetch costs
 * the sovereignty layer and nothing else, and says so through its own freshness
 * marker rather than failing the frame.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { bubbleFrom, getMapSystems } from '../eve/map-graph.js';
import { attributeKillsToGates } from '../eve-board/analytics.js';
import { assessShip } from '../eve-board/threat.js';
import type { GateKill, ShipAssessment } from '../eve-board/types.js';
import { getSignatures } from '../eve/eve-scout-client.js';
import {
  getAttackerActivity,
  getRecentKills,
  getRecentKillsForSystems,
  getSystemKillRollups,
  backfillSystems,
  type IndexedKill,
  type SystemKillRollup,
} from './kill-index.js';
import { scoreBubble, scoreSystemDanger, type DangerScore } from './danger.js';

export type LayerFreshness = {
  layer: string;
  status: 'live' | 'hourly' | 'cached' | 'unavailable';
  retrievedAt: string | null;
  /** Human-facing reason when the layer could not be filled. */
  error: string | null;
};

export type BubbleSystem = {
  systemId: number;
  name: string;
  jumps: number;
  security: number;
  securityClass: string | null;
  regionId: number | null;
  regionName: string | null;
  mapX: number;
  mapY: number;
  whClass: number | null;
  activity: SystemKillRollup;
  baselineShipKills: number;
  baselineNpcKills: number;
  baselineJumps: number;
  sovereigntyAllianceId: number | null;
  sovereigntyFactionId: number | null;
  gateCamps: GateKill[];
  danger: DangerScore;
};

export type BubbleWormhole = {
  signatureId: string;
  fromSystemId: number;
  toSystemId: number;
  toSystemName: string;
  whType: string;
  maxShipSize: string;
  remainingHours: number;
  expiresAt: string;
};

export type BubblePayload = {
  originId: number;
  radius: number;
  requestedRadius: number;
  truncated: boolean;
  systems: BubbleSystem[];
  edges: Array<[number, number]>;
  wormholes: BubbleWormhole[];
  recentKills: IndexedKill[];
  verdict: { score: number; band: string; worstSystemId: number | null };
  pilotShip: ShipAssessment | null;
  freshness: LayerFreshness[];
  builtAt: string;
};

export type BuildBubbleOptions = {
  radius?: number;
  /** The pilot's live hull, when the location scope is granted. */
  shipTypeId?: number | null;
  /** Skips the cold-start backfill; used by tests and by cheap refreshes. */
  skipBackfill?: boolean;
  now?: number;
};

const GATE_CAMP_WINDOW_MS = 60 * 60_000;
const RECENT_KILL_FEED_LIMIT = 60;

/**
 * Build the whole frame. Network layers are launched together and each is
 * awaited defensively, so one slow provider does not serialize behind another.
 */
export async function buildBubble(
  db: Db,
  originId: number,
  options: BuildBubbleOptions = {},
): Promise<BubblePayload> {
  const now = options.now ?? Date.now();
  const radius = Math.max(
    1,
    Math.min(config.map.bubbleMaxRadius, Math.floor(options.radius ?? config.map.bubbleDefaultRadius)),
  );

  const bubble = bubbleFrom(db, originId, radius, config.map.bubbleMaxNodes);
  const systemIds = bubble.nodes.map((node) => node.systemId);
  const jumpsBySystem = new Map(bubble.nodes.map((node) => [node.systemId, node.jumps]));
  const geometry = getMapSystems(db, systemIds);

  if (systemIds.length === 0) {
    return emptyPayload(originId, radius, now);
  }

  // The backfill only ever fires for systems nobody pulled recently, so a
  // second viewer of the same space pays nothing for it.
  if (!options.skipBackfill) {
    try {
      await backfillSystems(db, systemIds, now);
    } catch (error) {
      console.warn('[map-bubble] backfill failed: %s', (error as Error).message);
    }
  }

  const [baseline, jumpsBaseline, sovereignty, wormholes] = await Promise.all([
    fetchEsiSystemMetric(db, 'get_universe_system_kills'),
    fetchEsiSystemMetric(db, 'get_universe_system_jumps'),
    fetchSovereignty(db),
    fetchWormholes(db, new Set(systemIds), now),
  ]);

  const rollups = getSystemKillRollups(db, systemIds, now);
  const attackers = getAttackerActivity(db, systemIds, now - GATE_CAMP_WINDOW_MS);
  const pilotShip = options.shipTypeId ? safeAssessShip(db, options.shipTypeId) : null;

  const systems: BubbleSystem[] = [];
  const dangerScores = new Map<number, DangerScore>();

  for (const node of bubble.nodes) {
    const map = geometry.get(node.systemId);
    if (!map) continue;
    const rollup = rollups.get(node.systemId) ?? emptyRollupFor(node.systemId);
    const gateCamps = buildGateCamps(db, node.systemId, now);
    const systemAttackers = attackers.get(node.systemId) ?? [];
    const victimGroups = collectVictimGroups(db, node.systemId, now);
    const baselineRow = baseline.rows.get(node.systemId);

    const danger = scoreSystemDanger({
      systemId: node.systemId,
      security: map.security,
      rollup,
      attackers: systemAttackers,
      maxGateKills: gateCamps.reduce((max, camp) => Math.max(max, camp.killCount), 0),
      victimGroups,
      baselineShipKills1h: baselineRow?.shipKills ?? 0,
      pilotShip,
    });
    dangerScores.set(node.systemId, danger);

    systems.push({
      systemId: node.systemId,
      name: map.name,
      jumps: node.jumps,
      security: map.security,
      securityClass: map.securityClass,
      regionId: map.regionId,
      regionName: map.regionName,
      mapX: map.mapX,
      mapY: map.mapY,
      whClass: map.whClass,
      activity: rollup,
      baselineShipKills: baselineRow?.shipKills ?? 0,
      baselineNpcKills: baselineRow?.npcKills ?? 0,
      baselineJumps: jumpsBaseline.rows.get(node.systemId)?.shipJumps ?? 0,
      sovereigntyAllianceId: sovereignty.bySystem.get(node.systemId)?.allianceId ?? null,
      sovereigntyFactionId: sovereignty.bySystem.get(node.systemId)?.factionId ?? null,
      gateCamps,
      danger,
    });
  }

  const verdict = scoreBubble(dangerScores, jumpsBySystem);

  return {
    originId,
    radius: bubble.radius,
    requestedRadius: bubble.requestedRadius,
    truncated: bubble.truncated,
    systems,
    edges: bubble.edges,
    wormholes: wormholes.links,
    recentKills: getRecentKillsForSystems(db, systemIds, {
      limit: RECENT_KILL_FEED_LIMIT,
      sinceMs: now - GATE_CAMP_WINDOW_MS,
    }),
    verdict: { score: verdict.score, band: verdict.band, worstSystemId: verdict.worst?.systemId ?? null },
    pilotShip,
    freshness: [
      { layer: 'kills', status: 'live', retrievedAt: new Date(now).toISOString(), error: null },
      baseline.freshness,
      jumpsBaseline.freshness,
      sovereignty.freshness,
      wormholes.freshness,
    ],
    builtAt: new Date(now).toISOString(),
  };
}

/** Wormhole links usable by this hull, as extra router edges. */
export function wormholeEdges(payload: BubblePayload): Array<[number, number]> {
  return payload.wormholes.map((link) => [link.fromSystemId, link.toSystemId] as [number, number]);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

type BaselineRow = { shipKills: number; npcKills: number; shipJumps: number };

async function fetchEsiSystemMetric(
  db: Db,
  operation: 'get_universe_system_kills' | 'get_universe_system_jumps',
): Promise<{ rows: Map<number, BaselineRow>; freshness: LayerFreshness }> {
  const layer = operation === 'get_universe_system_kills' ? 'esi_kills' : 'esi_jumps';
  const rows = new Map<number, BaselineRow>();
  try {
    const response = await callEsiOperation<unknown>(db, operation, {}, null);
    if (!response.ok || !Array.isArray(response.data)) {
      return {
        rows,
        freshness: {
          layer,
          status: 'unavailable',
          retrievedAt: null,
          error: response.ok ? 'unexpected ESI payload' : response.error,
        },
      };
    }
    for (const entry of response.data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const systemId = record.system_id;
      if (typeof systemId !== 'number') continue;
      rows.set(systemId, {
        shipKills: numberOr(record.ship_kills, 0),
        npcKills: numberOr(record.npc_kills, 0),
        shipJumps: numberOr(record.ship_jumps, 0),
      });
    }
    // Labelled 'hourly', never 'live': these endpoints are cached one hour and
    // presenting them as current would be a lie the map cannot afford.
    return {
      rows,
      freshness: { layer, status: 'hourly', retrievedAt: new Date().toISOString(), error: null },
    };
  } catch (error) {
    return {
      rows,
      freshness: { layer, status: 'unavailable', retrievedAt: null, error: (error as Error).message },
    };
  }
}

async function fetchSovereignty(db: Db): Promise<{
  bySystem: Map<number, { allianceId: number | null; factionId: number | null }>;
  freshness: LayerFreshness;
}> {
  const bySystem = new Map<number, { allianceId: number | null; factionId: number | null }>();
  try {
    const response = await callEsiOperation<unknown>(db, 'get_sovereignty_map', {}, null);
    if (!response.ok || !Array.isArray(response.data)) {
      return {
        bySystem,
        freshness: {
          layer: 'sovereignty',
          status: 'unavailable',
          retrievedAt: null,
          error: response.ok ? 'unexpected ESI payload' : response.error,
        },
      };
    }
    for (const entry of response.data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const systemId = record.system_id;
      if (typeof systemId !== 'number') continue;
      bySystem.set(systemId, {
        allianceId: typeof record.alliance_id === 'number' ? record.alliance_id : null,
        factionId: typeof record.faction_id === 'number' ? record.faction_id : null,
      });
    }
    return {
      bySystem,
      freshness: { layer: 'sovereignty', status: 'hourly', retrievedAt: new Date().toISOString(), error: null },
    };
  } catch (error) {
    return {
      bySystem,
      freshness: { layer: 'sovereignty', status: 'unavailable', retrievedAt: null, error: (error as Error).message },
    };
  }
}

async function fetchWormholes(
  db: Db,
  inBubble: Set<number>,
  now: number,
): Promise<{ links: BubbleWormhole[]; freshness: LayerFreshness }> {
  try {
    const response = await getSignatures(db);
    if (!response.ok) {
      return {
        links: [],
        freshness: { layer: 'wormholes', status: 'unavailable', retrievedAt: null, error: response.error },
      };
    }
    const links: BubbleWormhole[] = [];
    for (const signature of response.data) {
      // An expired signature is a hole that is already gone; routing through it
      // would send a pilot to a dead end.
      const expiresAt = Date.parse(signature.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt <= now) continue;
      if (signature.signature_type && signature.signature_type !== 'wormhole') continue;
      const touches = inBubble.has(signature.in_system_id) || inBubble.has(signature.out_system_id);
      if (!touches) continue;
      links.push({
        signatureId: signature.id,
        fromSystemId: signature.out_system_id,
        toSystemId: signature.in_system_id,
        toSystemName: signature.in_system_name,
        whType: signature.wh_type,
        maxShipSize: signature.max_ship_size,
        remainingHours: signature.remaining_hours,
        expiresAt: signature.expires_at,
      });
    }
    return {
      links,
      freshness: { layer: 'wormholes', status: 'cached', retrievedAt: new Date(now).toISOString(), error: null },
    };
  } catch (error) {
    return {
      links: [],
      freshness: { layer: 'wormholes', status: 'unavailable', retrievedAt: null, error: (error as Error).message },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGateCamps(db: Db, systemId: number, now: number): GateKill[] {
  const kills = getRecentKills(db, systemId, { limit: 60, sinceMs: now - GATE_CAMP_WINDOW_MS });
  const withPosition = kills
    .filter((kill) => kill.position !== null && !kill.isNpc)
    .map((kill) => ({
      killmail_id: kill.killmailId,
      killmail_time: kill.killmailTime ?? undefined,
      position: kill.position ?? undefined,
    }));
  if (withPosition.length === 0) return [];
  try {
    return attributeKillsToGates(db, systemId, withPosition);
  } catch {
    return [];
  }
}

function collectVictimGroups(db: Db, systemId: number, now: number): string[] {
  const kills = getRecentKills(db, systemId, { limit: 20, sinceMs: now - GATE_CAMP_WINDOW_MS });
  const groups: string[] = [];
  for (const kill of kills) {
    if (kill.isNpc) continue;
    if (kill.victimShipGroupName) groups.push(kill.victimShipGroupName);
  }
  return groups;
}

function safeAssessShip(db: Db, shipTypeId: number): ShipAssessment | null {
  try {
    return assessShip(db, shipTypeId);
  } catch {
    return null;
  }
}

function emptyRollupFor(systemId: number): SystemKillRollup {
  return {
    systemId,
    kills15m: 0,
    kills1h: 0,
    kills24h: 0,
    pvpKills1h: 0,
    npcKills1h: 0,
    valueDestroyed1h: 0,
    soloKills1h: 0,
    lastKillMinutesAgo: null,
    lastKillAtMs: null,
  };
}

function emptyPayload(originId: number, radius: number, now: number): BubblePayload {
  return {
    originId,
    radius: 0,
    requestedRadius: radius,
    truncated: false,
    systems: [],
    edges: [],
    wormholes: [],
    recentKills: [],
    verdict: { score: 0, band: 'calm', worstSystemId: null },
    pilotShip: null,
    freshness: [{
      layer: 'graph',
      status: 'unavailable',
      retrievedAt: null,
      error: `System ${originId} is not present in the map graph.`,
    }],
    builtAt: new Date(now).toISOString(),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
