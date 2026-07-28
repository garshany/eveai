/**
 * Perimeter agent tools.
 *
 * Each one hands the model a finished, server-computed answer instead of raw
 * material it would have to fan out to assemble. That is the whole design: the
 * map already knows what is around the pilot, so the model should read one
 * prepared payload rather than issue thirty lookups and guess at the arithmetic.
 *
 * Every payload is bounded — capped row counts, no private ESI beyond what the
 * caller already owns, and no free-form identifiers reaching an outbound call.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import type { NativeFunctionTool } from '../agent/native-responses.js';
import { getMapSystem, routeWithRisk, type RouteMode } from '../eve/map-graph.js';
import { assessShip } from '../eve-board/threat.js';
import { buildBubble } from './bubble.js';
import { getGateCampHistory, getRecentKills } from './kill-index.js';
import { currentHourOfWeek, getSystemProfile, mortalityPerThousandJumps } from './system-metrics.js';

export const MAP_BUBBLE_INTEL_TOOL_NAME = 'map_bubble_intel';
export const ROUTE_RISK_TOOL_NAME = 'route_risk';
export const COMPARE_SHIPS_TOOL_NAME = 'compare_ships';
export const THREAT_EXPLAIN_TOOL_NAME = 'threat_explain';

const MAX_SYSTEMS_IN_PAYLOAD = 40;
const MAX_KILLS_IN_PAYLOAD = 15;

export const PERIMETER_TOOLS: NativeFunctionTool[] = [
  {
    type: 'function',
    name: MAP_BUBBLE_INTEL_TOOL_NAME,
    description:
      'Live Perimeter picture around one system: every system within the jump radius with its danger score and the labelled terms behind it, '
      + 'live kill counts (15m/1h/24h) from the local kill index, gate camps, sovereignty, wormhole exits, and an overall verdict. '
      + 'Use this instead of issuing separate kill searches or ESI system-metric calls — it is one prepared payload and it is seconds fresh. '
      + 'The hourly ESI baseline is reported separately and must never be described as live.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        system_id: { type: 'integer', description: 'Centre of the bubble. Use the pilot\'s current system when asking about "around me".' },
        // The operator's ceiling is clamped at execution, not baked into the
        // schema: this array is a module constant, and reading config here
        // would make tool discovery depend on config being loaded first.
        radius: { type: ['integer', 'null'], description: 'Jump radius. Null uses the operator default; larger values are clamped to the operator ceiling.' },
        ship_type_id: { type: ['integer', 'null'], description: 'The pilot\'s current hull, so danger is scored for that ship. Null scores it hull-agnostically.' },
      },
      required: ['system_id', 'radius', 'ship_type_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: ROUTE_RISK_TOOL_NAME,
    description:
      'Plan a route weighted by live danger rather than by jumps alone. Returns the path with a per-hop cost breakdown explaining every detour. '
      + 'risk_weight 0 is the plain shortest path; raising it trades jumps for safety. Use this when the pilot asks how to get somewhere safely, '
      + 'and quote the breakdown rather than asserting a route is safe.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        origin_system_id: { type: 'integer' },
        destination_system_id: { type: 'integer' },
        mode: { type: 'string', enum: ['shortest', 'secure', 'insecure'] },
        risk_weight: { type: 'number', description: '0..20. Roughly "how many extra jumps am I willing to fly to avoid one maximally dangerous system".' },
      },
      required: ['origin_system_id', 'destination_system_id', 'mode', 'risk_weight'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: COMPARE_SHIPS_TOOL_NAME,
    description:
      'Compare two hulls on the numbers that decide whether one catches and kills the other: effective HP, align time, warp speed, signature, '
      + 'hull class, and a survivability verdict. Values come from the local SDE dogma data. Use this for "can that X catch my Y".',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        ship_type_id_a: { type: 'integer' },
        ship_type_id_b: { type: 'integer' },
      },
      required: ['ship_type_id_a', 'ship_type_id_b'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: THREAT_EXPLAIN_TOOL_NAME,
    description:
      'Explain why one system is dangerous: the recent killmails with victim, attacker, both hulls, value and age, which attackers appear more than once, '
      + 'and which stargate the kills cluster on. Use this whenever asked "why is this system red" — never invent a reason.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        system_id: { type: 'integer' },
      },
      required: ['system_id'],
      additionalProperties: false,
    },
  },
];

export function isPerimeterTool(name: string): boolean {
  return name === MAP_BUBBLE_INTEL_TOOL_NAME
    || name === ROUTE_RISK_TOOL_NAME
    || name === COMPARE_SHIPS_TOOL_NAME
    || name === THREAT_EXPLAIN_TOOL_NAME;
}

/**
 * Validate and execute. Arguments arrive from a model, so every one is checked
 * here rather than trusted from the schema: a strict schema is a contract with
 * a cooperative caller, not a guarantee.
 */
export async function executePerimeterTool(
  db: Db,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case MAP_BUBBLE_INTEL_TOOL_NAME: return await bubbleIntel(db, rawArgs);
    case ROUTE_RISK_TOOL_NAME: return await routeRisk(db, rawArgs);
    case COMPARE_SHIPS_TOOL_NAME: return compareShips(db, rawArgs);
    case THREAT_EXPLAIN_TOOL_NAME: return threatExplain(db, rawArgs);
    default: return failure(`Unknown Perimeter tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// map_bubble_intel
// ---------------------------------------------------------------------------

async function bubbleIntel(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const systemId = readId(args.system_id);
  if (systemId === null) return failure('system_id must be a positive integer.');
  if (!getMapSystem(db, systemId)) return failure(`System ${systemId} is not in the map graph.`);

  const radius = readOptionalInt(args.radius) ?? config.map.bubbleDefaultRadius;
  const shipTypeId = readOptionalInt(args.ship_type_id);

  const bubble = await buildBubble(db, systemId, {
    radius,
    shipTypeId,
    skipBackfill: false,
  });

  // The model does not need a thousand quiet systems. Rank by danger and hand
  // over the ones that change a decision, with the count that was dropped so
  // the answer can be honest about coverage.
  const ranked = [...bubble.systems].sort((a, b) => b.danger.score - a.danger.score);
  const shown = ranked.slice(0, MAX_SYSTEMS_IN_PAYLOAD);

  return {
    ok: true,
    origin_system_id: systemId,
    radius: bubble.radius,
    requested_radius: bubble.requestedRadius,
    truncated: bubble.truncated,
    system_count: bubble.systems.length,
    systems_shown: shown.length,
    systems_omitted: bubble.systems.length - shown.length,
    verdict: bubble.verdict,
    pilot_ship: bubble.pilotShip,
    freshness: bubble.freshness,
    systems: shown.map((system) => ({
      system_id: system.systemId,
      name: system.name,
      jumps: system.jumps,
      security: system.security,
      region: system.regionName,
      danger_score: system.danger.score,
      danger_band: system.danger.band,
      danger_terms: system.danger.terms,
      kills_15m: system.activity.kills15m,
      kills_1h: system.activity.kills1h,
      pvp_kills_1h: system.activity.pvpKills1h,
      value_destroyed_1h: system.activity.valueDestroyed1h,
      last_kill_minutes_ago: system.activity.lastKillMinutesAgo,
      esi_baseline_ship_kills_1h: system.baselineShipKills,
      gate_camps: system.gateCamps,
      sovereignty_alliance_id: system.sovereigntyAllianceId,
    })),
    wormholes: bubble.wormholes,
  };
}

// ---------------------------------------------------------------------------
// route_risk
// ---------------------------------------------------------------------------

async function routeRisk(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const origin = readId(args.origin_system_id);
  const destination = readId(args.destination_system_id);
  if (origin === null || destination === null) {
    return failure('origin_system_id and destination_system_id must be positive integers.');
  }
  const mode: RouteMode = args.mode === 'secure' || args.mode === 'insecure' ? args.mode : 'shortest';
  const riskWeight = Math.max(0, Math.min(20, Number(args.risk_weight) || 0));

  const bubble = await buildBubble(db, origin, {
    radius: config.map.bubbleMaxRadius,
    skipBackfill: true,
  });
  const dangerBySystem = new Map(bubble.systems.map((system) => [system.systemId, system.danger.score]));

  const route = routeWithRisk(db, origin, destination, {
    mode,
    riskWeight,
    dangerOf: (systemId) => dangerBySystem.get(systemId) ?? 0,
  });
  if (!route.ok) return failure(route.error ?? 'No route found.');

  // A comparison the model would otherwise have to invent: what the pilot
  // actually pays for the safer path.
  const baseline = routeWithRisk(db, origin, destination, { mode: 'shortest', riskWeight: 0 });

  return {
    ok: true,
    mode,
    risk_weight: riskWeight,
    jumps: route.jumps,
    shortest_jumps: baseline.ok ? baseline.jumps : null,
    extra_jumps_for_safety: baseline.ok ? route.jumps - baseline.jumps : null,
    total_cost: Math.round(route.totalCost * 100) / 100,
    danger_coverage: {
      known_systems: route.systemIds.filter((id) => dangerBySystem.has(id)).length,
      total_systems: route.systemIds.length,
      note: 'Systems outside the danger bubble are scored 0, not "safe".',
    },
    hops: route.hops.map((hop) => {
      const system = getMapSystem(db, hop.systemId);
      return {
        system_id: hop.systemId,
        name: system?.name ?? `System ${hop.systemId}`,
        security: system?.security ?? null,
        cost: Math.round(hop.cost * 100) / 100,
        terms: hop.terms,
        danger_score: dangerBySystem.get(hop.systemId) ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// compare_ships
// ---------------------------------------------------------------------------

function compareShips(db: Db, args: Record<string, unknown>): Record<string, unknown> {
  const a = readId(args.ship_type_id_a);
  const b = readId(args.ship_type_id_b);
  if (a === null || b === null) return failure('Both ship type IDs must be positive integers.');

  let shipA;
  let shipB;
  try {
    shipA = assessShip(db, a);
    shipB = assessShip(db, b);
  } catch (error) {
    return failure(`Ship data unavailable: ${(error as Error).message}`);
  }

  // Align time decides whether a chase even starts, so it is called out
  // explicitly rather than left for the model to compare from two numbers.
  const alignAdvantage = shipA.alignTime === shipB.alignTime
    ? null
    : shipA.alignTime < shipB.alignTime ? shipA.shipName : shipB.shipName;

  return {
    ok: true,
    ships: [shipA, shipB],
    comparison: {
      tougher: shipA.ehp === shipB.ehp ? null : shipA.ehp > shipB.ehp ? shipA.shipName : shipB.shipName,
      ehp_ratio: shipB.ehp > 0 ? Math.round((shipA.ehp / shipB.ehp) * 100) / 100 : null,
      faster_align: alignAdvantage,
      align_delta_seconds: Math.round(Math.abs(shipA.alignTime - shipB.alignTime) * 10) / 10,
      faster_warp: shipA.warpSpeed === shipB.warpSpeed
        ? null
        : shipA.warpSpeed > shipB.warpSpeed ? shipA.shipName : shipB.shipName,
    },
    note: 'Hull values from the local SDE dogma data. Fittings, implants, and skills are not included and can change every number here.',
  };
}

// ---------------------------------------------------------------------------
// threat_explain
// ---------------------------------------------------------------------------

function threatExplain(db: Db, args: Record<string, unknown>): Record<string, unknown> {
  const systemId = readId(args.system_id);
  if (systemId === null) return failure('system_id must be a positive integer.');
  const system = getMapSystem(db, systemId);
  if (!system) return failure(`System ${systemId} is not in the map graph.`);

  const kills = getRecentKills(db, systemId, { limit: MAX_KILLS_IN_PAYLOAD });
  const attackerCounts = new Map<number, { name: string | null; kills: number }>();
  for (const kill of kills) {
    if (kill.isNpc || kill.finalBlowCharacterId === null) continue;
    const current = attackerCounts.get(kill.finalBlowCharacterId)
      ?? { name: kill.finalBlowCharacterName, kills: 0 };
    current.kills += 1;
    attackerCounts.set(kill.finalBlowCharacterId, current);
  }

  return {
    ok: true,
    system: {
      system_id: system.systemId,
      name: system.name,
      security: system.security,
      region: system.regionName,
    },
    kill_count: kills.length,
    // No kills is an answer, not an absence: the model must be able to say
    // "nothing has died here recently" instead of hedging.
    kills: kills.map((kill) => ({
      killmail_id: kill.killmailId,
      at: kill.killmailTime,
      minutes_ago: Math.round((Date.now() - kill.killmailTimeMs) / 60_000),
      victim: kill.victimCharacterName,
      victim_ship: kill.victimShipName,
      victim_corporation: kill.victimCorporationName,
      attacker: kill.finalBlowCharacterName,
      attacker_ship: kill.finalBlowShipName,
      attacker_count: kill.attackerCount,
      value_isk: kill.totalValue,
      npc: kill.isNpc,
      solo: kill.isSolo,
      url: `https://eve-kill.com/kill/${kill.killmailId}`,
    })),
    repeat_attackers: [...attackerCounts.entries()]
      .filter(([, entry]) => entry.kills > 1)
      .map(([characterId, entry]) => ({ character_id: characterId, name: entry.name, kills: entry.kills })),
    // Accumulated memory, not a live reading: empty until the instance has been
    // collecting for a while, and it says so rather than guessing.
    gate_camp_history: getGateCampHistory(db, systemId).map((gate) => ({
      gate_id: gate.gateId,
      leads_to_system_id: gate.destinationSystemId,
      total_kills_recorded: gate.totalKills,
      last_kill_at: new Date(gate.lastKillMs).toISOString(),
      peak_hours_utc: gate.peakHours.map((hour) => ({
        day_of_week: Math.floor(hour.hourOfWeek / 24),
        hour_utc: hour.hourOfWeek % 24,
        kills: hour.kills,
      })),
      regulars: gate.campers.map((camper) => ({
        character_id: camper.characterId,
        name: camper.name,
        corporation: camper.corporation,
        kills: camper.kills,
      })),
    })),
    traffic: buildTrafficContext(db, systemId),
    coverage_note: `Live killmail detail is retained ${config.map.killIndexRetentionHours}h; `
      + `gate kills and camp history are kept far longer. EVE time is UTC, so peak hours are EVE hours.`,
  };
}

/**
 * Traffic context for one system: without it, "three kills in an hour" is
 * unreadable — three kills against a thousand jumps and three against ten are
 * different systems entirely.
 */
function buildTrafficContext(db: Db, systemId: number): Record<string, unknown> {
  const hourOfWeek = currentHourOfWeek();
  const profile = getSystemProfile(db, systemId, hourOfWeek);
  if (!profile) {
    return {
      available: false,
      note: 'No accumulated traffic baseline for this system and hour yet. '
        + 'ESI publishes jumps per system per hour; this instance stores them as they arrive.',
    };
  }
  return {
    available: true,
    hour_utc: hourOfWeek % 24,
    day_of_week: Math.floor(hourOfWeek / 24),
    samples: profile.samples,
    avg_ship_jumps_this_hour: Math.round(profile.avgShipJumps * 10) / 10,
    avg_ship_kills_this_hour: Math.round(profile.avgShipKills * 100) / 100,
    deaths_per_1000_jumps: roundOrNull(mortalityPerThousandJumps(db, systemId, hourOfWeek)),
    note: 'Traffic is per system, hourly. No public data exists for jumps through an individual gate.',
  };
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failure(error: string): Record<string, unknown> {
  return { ok: false, error };
}

function readId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readOptionalInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
