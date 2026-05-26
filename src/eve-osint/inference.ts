import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getEntityDetail, getEntityMembers } from '../eve-kill/client.js';
import { analyzeOsintGraphPatterns } from './llm.js';
import { analyzeMovement, detectDeployments, detectReturnHubs } from './movement.js';
import { analyzeShipProfile, analyzeFleetProfile } from './ships.js';
import { detectAlts, analyzeVulnerability } from './social.js';
import { analyzeTemporalProfile, reconstructSessions } from './temporal.js';
import { fetchEntityActivityFeed, type OsintKillmail } from './zkill.js';
import type { OsintInferenceArgs, OsintScope } from './types.js';

export type { OsintInferenceArgs, OsintScope } from './types.js';

type SystemMetrics = {
  systemId: number;
  systemName: string;
  regionId: number | null;
  regionName: string | null;
  security: number | null;
  kills: number;
  losses: number;
  encounters: number;
  totalValue: number;
  soloEncounters: number;
  uniqueDays: Set<string>;
  memberIds: Set<number>;
  timezones: Map<string, number>;
  locations: Map<string, number>;
  recentWeight: number;
  baseScore: number;
  adjacencySupport: number;
  hubPenalty: number;
  finalScore: number;
};

type RegionMetrics = {
  regionId: number;
  regionName: string;
  kills: number;
  losses: number;
  encounters: number;
  uniqueDays: Set<string>;
  systemIds: Set<number>;
  recentWeight: number;
  baseScore: number;
  finalScore: number;
};

type GraphNode = {
  id: string;
  kind: 'entity' | 'character' | 'system';
  label: string;
  weight: number;
};

type GraphEdge = {
  source: string;
  target: string;
  kind: 'activity' | 'coactivity' | 'adjacent';
  weight: number;
};

type GraphDigest = {
  entity: {
    scope: OsintScope;
    id: number;
  };
  window_days: number;
  kill_count: number;
  top_regions: Array<Record<string, unknown>>;
  top_systems: Array<Record<string, unknown>>;
  clusters: Array<Record<string, unknown>>;
  core_members: Array<Record<string, unknown>>;
  signals: Record<string, number>;
};

type MemberStats = {
  characterId: number;
  name: string;
  systems: Set<string>;
  kills: number;
  losses: number;
  appearances: number;
};

type NpcSystemMetrics = {
  systemId: number;
  count: number;
  uniqueDays: Set<string>;
};

type SoloLossMetrics = {
  systemId: number;
  count: number;
  uniqueDays: Set<string>;
  totalValue: number;
};

type CollectedEvidence = {
  kills: OsintKillmail[];
  systems: Map<number, SystemMetrics>;
  regions: Map<number, RegionMetrics>;
  members: Map<number, MemberStats>;
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  adjacency: Map<number, Set<number>>;
  timezones: Map<string, number>;
  locations: Map<string, number>;
  npcSystems: Map<number, NpcSystemMetrics>;
  soloLossSystems: Map<number, SoloLossMetrics>;
  filtered: {
    npc: number;
    awox: number;
    incomplete: number;
  };
  sourceWindowDays: number;
};

type HypothesisKind = 'home_system' | 'staging_system' | 'hunting_area';

const MAX_GRAPH_SYSTEMS = 8;
const MAX_GRAPH_MEMBERS = 8;
const HUB_SYSTEMS = new Set(['jita', 'perimeter', 'amarr', 'dodixie', 'hek', 'rens', 'uedama', 'tama', 'ahbazon']);
const MIN_VALUE_FOR_SPIKE_TRUST = 75_000_000;

export async function executeOsintInferHome(
  db: Db,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const args = normalizeArgs(rawArgs);
  if (!args) {
    return { ok: false, error: 'scope must be character, corporation, or alliance; id must be a positive integer.' };
  }

  const entityName = await resolveEntityName(db, args.scope, args.id);
  const evidence = await collectEvidence(db, args);
  if (evidence.kills.length === 0 || evidence.systems.size === 0) {
    return {
      ok: true,
      scope: args.scope,
      id: args.id,
      entity_name: entityName,
      window_days: args.windowDays,
      source_window_days: evidence.sourceWindowDays,
      hypotheses: [],
      activity_cluster: null,
      member_analysis: {
        total_members_observed: evidence.members.size,
        members_analyzed: 0,
        core_members: [],
      },
      graph_digest: args.includeGraph ? emptyGraphDigest(args) : null,
      llm_pattern_analysis: null,
      uncertainty: ['Недостаточно свежих killboard-данных для inference в заданном окне.'],
    };
  }

  scoreSystems(evidence.systems, evidence.regions, evidence.adjacency);
  const hypotheses = buildHypotheses(evidence);
  const cluster = buildCluster(evidence.systems, evidence.adjacency);
  const memberSummary = args.includeMemberAnalysis ? await buildMemberSummary(db, evidence.members) : [];
  const graphDigest = buildGraphDigest(args, evidence, cluster, memberSummary);

  const temporalProfile = analyzeTemporalProfile(evidence.kills);
  const sessionProfile = reconstructSessions(evidence.kills);
  const shipProfile = analyzeShipProfile(db, evidence.kills, args.scope, args.id);
  const fleetProfile = analyzeFleetProfile(evidence.kills, args.id);
  const movementProfile = analyzeMovement(db, evidence.kills);
  const deploymentProfile = detectDeployments(db, evidence.kills);
  const returnHubs = detectReturnHubs(db, evidence.kills);
  const altProfile = detectAlts(evidence.kills, args.scope, args.id);
  const vulnerabilityProfile = analyzeVulnerability(evidence.kills);
  const homeHypotheses = buildHomeHypothesis(db, evidence, returnHubs.hubs);

  const llmPatternAnalysis = args.includeLlmPatternAnalysis
    ? await analyzeOsintGraphPatterns({
      ...graphDigest,
      hypotheses,
      temporal: {
        estimated_timezone: temporalProfile.estimated_timezone,
        peak_hours: temporalProfile.peak_hours,
        sleep_window: temporalProfile.sleep_window,
        activity_regularity: temporalProfile.activity_regularity,
        active_days_per_week: temporalProfile.active_days_per_week,
      },
      sessions: {
        sessions_count: sessionProfile.sessions_count,
        avg_session_minutes: sessionProfile.avg_session_minutes,
        sessions_per_week: sessionProfile.sessions_per_week,
        total_play_hours: sessionProfile.total_play_hours,
      },
      ship_profile: {
        favorite_ship: shipProfile.favorite_ship,
        dominant_hull_class: shipProfile.dominant_hull_class,
        capital_usage: shipProfile.capital_usage,
        ship_diversity: shipProfile.ship_diversity,
        top_ships: shipProfile.ships.slice(0, 5).map((s) => ({
          name: s.ship_name, hull_class: s.hull_class, times_flown: s.times_flown,
        })),
      },
      fleet_profile: {
        avg_fleet_size: fleetProfile.avg_fleet_size,
        solo_ratio: fleetProfile.solo_ratio,
        small_gang_ratio: fleetProfile.small_gang_ratio,
        medium_fleet_ratio: fleetProfile.medium_fleet_ratio,
        large_fleet_ratio: fleetProfile.large_fleet_ratio,
      },
      movement: {
        unique_systems: movementProfile.unique_systems,
        geographic_spread: movementProfile.geographic_spread,
        top_routes: movementProfile.routes.slice(0, 5),
        travel_pipes: movementProfile.travel_pipes.slice(0, 3),
      },
      deployments: {
        current_region: deploymentProfile.current_region,
        region_stability: deploymentProfile.region_stability,
        moves_count: deploymentProfile.moves_count,
      },
      vulnerability: {
        vulnerability_score: vulnerabilityProfile.vulnerability_score,
        peak_loss_hours: vulnerabilityProfile.peak_loss_hours,
        loss_patterns: vulnerabilityProfile.loss_patterns,
        best_ambush_window: vulnerabilityProfile.best_ambush_window,
        total_losses: vulnerabilityProfile.total_losses,
      },
      alt_detection: {
        characters_analyzed: altProfile.characters_analyzed,
        suspected_alts_count: altProfile.suspected_alts.length,
      },
      home_hypotheses: homeHypotheses.slice(0, 3),
      return_hubs: returnHubs.hubs.slice(0, 3),
      npc_ratting_systems: evidence.npcSystems.size,
      total_npc_kills: [...evidence.npcSystems.values()].reduce((s, n) => s + n.count, 0),
    })
    : null;

  return {
    ok: true,
    scope: args.scope,
    id: args.id,
    entity_name: entityName,
    window_days: args.windowDays,
    source_window_days: evidence.sourceWindowDays,
    kill_count: evidence.kills.length,
    hypotheses,
    home_hypotheses: homeHypotheses,
    return_hubs: returnHubs.hubs.slice(0, 3),
    activity_cluster: cluster,
    temporal: {
      estimated_timezone: temporalProfile.estimated_timezone,
      peak_hours: temporalProfile.peak_hours,
      sleep_window: temporalProfile.sleep_window,
      activity_regularity: temporalProfile.activity_regularity,
      active_days_per_week: temporalProfile.active_days_per_week,
      sample_size: temporalProfile.sample_size,
    },
    sessions: {
      sessions_count: sessionProfile.sessions_count,
      avg_session_minutes: sessionProfile.avg_session_minutes,
      median_session_minutes: sessionProfile.median_session_minutes,
      longest_session_minutes: sessionProfile.longest_session_minutes,
      sessions_per_week: sessionProfile.sessions_per_week,
      total_play_hours: sessionProfile.total_play_hours,
    },
    ship_profile: {
      ships: shipProfile.ships.slice(0, 8),
      favorite_ship: shipProfile.favorite_ship,
      dominant_hull_class: shipProfile.dominant_hull_class,
      ship_diversity: shipProfile.ship_diversity,
      capital_usage: shipProfile.capital_usage,
      total_flights: shipProfile.total_flights,
    },
    fleet_profile: fleetProfile,
    movement: {
      routes: movementProfile.routes.slice(0, 5),
      travel_pipes: movementProfile.travel_pipes.slice(0, 3),
      unique_systems: movementProfile.unique_systems,
      geographic_spread: movementProfile.geographic_spread,
    },
    deployments: deploymentProfile,
    alt_detection: altProfile,
    vulnerability: {
      peak_loss_hours: vulnerabilityProfile.peak_loss_hours,
      vulnerable_systems: vulnerabilityProfile.vulnerable_systems,
      frequently_lost_ships: vulnerabilityProfile.frequently_lost_ships.slice(0, 3),
      loss_patterns: vulnerabilityProfile.loss_patterns,
      best_ambush_window: vulnerabilityProfile.best_ambush_window,
      vulnerability_score: vulnerabilityProfile.vulnerability_score,
      total_losses: vulnerabilityProfile.total_losses,
    },
    npc_activity: {
      systems_with_ratting: evidence.npcSystems.size,
      total_npc_kills: [...evidence.npcSystems.values()].reduce((s, n) => s + n.count, 0),
      top_ratting_systems: [...evidence.npcSystems.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((n) => ({
          system_id: n.systemId,
          system_name: resolveSystemName(db, n.systemId) ?? `system:${n.systemId}`,
          npc_kills: n.count,
          unique_days: n.uniqueDays.size,
        })),
    },
    member_analysis: {
      total_members_observed: evidence.members.size,
      members_analyzed: memberSummary.length,
      core_members: memberSummary,
    },
    llm_pattern_analysis: llmPatternAnalysis,
    uncertainty: mergeUncertainty(args, evidence, hypotheses, llmPatternAnalysis),
  };
}

export const executeOsintInference = executeOsintInferHome;

function normalizeArgs(raw: Record<string, unknown>): OsintInferenceArgs | null {
  const scope = raw.scope;
  const id = raw.id;
  if ((scope !== 'character' && scope !== 'corporation' && scope !== 'alliance') || typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return null;
  }
  return {
    scope,
    id,
    windowDays: typeof raw.window_days === 'number' && Number.isFinite(raw.window_days)
      ? Math.max(1, Math.min(90, Math.trunc(raw.window_days)))
      : 30,
    includeMemberAnalysis: raw.include_member_analysis !== false,
    includeGraph: raw.include_graph !== false,
    includeLlmPatternAnalysis: raw.include_llm_pattern_analysis !== false,
  };
}

async function collectEvidence(db: Db, args: OsintInferenceArgs): Promise<CollectedEvidence> {
  const cutoffMs = Date.now() - args.windowDays * 86_400_000;
  const systems = new Map<number, SystemMetrics>();
  const regions = new Map<number, RegionMetrics>();
  const members = new Map<number, MemberStats>();
  const graphNodes = new Map<string, GraphNode>();
  const graphEdges = new Map<string, GraphEdge>();
  const timezones = new Map<string, number>();
  const locations = new Map<string, number>();
  const npcSystems = new Map<number, NpcSystemMetrics>();
  const soloLossSystems = new Map<number, SoloLossMetrics>();
  const filtered = { npc: 0, awox: 0, incomplete: 0 };

  const pastSeconds = Math.max(86_400, args.windowDays * 86_400);
  const sourceWindowDays = pastSeconds <= config.zkill.maxPastSeconds
    ? Math.max(1, Math.floor(pastSeconds / 86_400))
    : args.windowDays;
  const [killsFeed, lossesFeed] = await Promise.all([
    fetchEntityActivityFeed(db, { scope: args.scope, id: args.id, activity: 'kills', pastSeconds }),
    fetchEntityActivityFeed(db, { scope: args.scope, id: args.id, activity: 'losses', pastSeconds }),
  ]);

  const deduped = new Map<number, OsintKillmail>();
  for (const kill of [...killsFeed, ...lossesFeed]) {
    if (!deduped.has(kill.killmail_id)) deduped.set(kill.killmail_id, kill);
  }

  for (const kill of deduped.values()) {
    const timeMs = kill.killmail_time ? new Date(kill.killmail_time).getTime() : 0;
    if (timeMs > 0 && timeMs < cutoffMs) continue;
    const systemId = typeof kill.solar_system_id === 'number' ? kill.solar_system_id : null;
    if (!systemId || !kill.killmail_time) {
      filtered.incomplete += 1;
      continue;
    }
    if (kill.is_npc) {
      filtered.npc += 1;
      const dayKey = kill.killmail_time.slice(0, 10);
      const npc = npcSystems.get(systemId) ?? { systemId, count: 0, uniqueDays: new Set<string>() };
      npc.count += 1;
      npc.uniqueDays.add(dayKey);
      npcSystems.set(systemId, npc);
      continue;
    }
    if (kill.is_awox) {
      filtered.awox += 1;
      continue;
    }
    if (kill.activity === 'losses' && kill.attacker_count >= 1 && kill.attacker_count <= 3) {
      const dayKey = kill.killmail_time.slice(0, 10);
      const solo = soloLossSystems.get(systemId) ?? { systemId, count: 0, uniqueDays: new Set<string>(), totalValue: 0 };
      solo.count += 1;
      solo.uniqueDays.add(dayKey);
      solo.totalValue += kill.total_value ?? 0;
      soloLossSystems.set(systemId, solo);
    }

    const systemName = resolveSystemName(db, systemId) ?? `system:${systemId}`;
    const security = resolveSystemSecurity(db, systemId);
    const { regionId, regionName } = resolveSystemRegion(db, systemId);
    const dayKey = kill.killmail_time.slice(0, 10);
    const role = kill.activity === 'losses' ? 'loss' : 'kill';
    const valueWeight = computeValueWeight(kill.total_value);
    const weightedRecency = recencyWeight(kill.killmail_time) * valueWeight;

    const metrics = systems.get(systemId) ?? {
      systemId,
      systemName,
      regionId,
      regionName,
      security,
      kills: 0,
      losses: 0,
      encounters: 0,
      totalValue: 0,
      soloEncounters: 0,
      uniqueDays: new Set<string>(),
      memberIds: new Set<number>(),
      timezones: new Map<string, number>(),
      locations: new Map<string, number>(),
      recentWeight: 0,
      baseScore: 0,
      adjacencySupport: 0,
      hubPenalty: 0,
      finalScore: 0,
    };

    metrics.encounters += 1;
    metrics.totalValue += kill.total_value ?? 0;
    metrics.uniqueDays.add(dayKey);
    if (kill.is_solo) metrics.soloEncounters += 1;
    if (role === 'loss') metrics.losses += 1;
    else metrics.kills += 1;
    metrics.recentWeight += weightedRecency;
    bumpCounter(metrics.timezones, kill.tz_label);
    bumpCounter(metrics.locations, kill.location_label);
    systems.set(systemId, metrics);

    addRegionEvidence(regions, regionId, regionName, systemId, dayKey, role, weightedRecency);
    bumpCounter(timezones, kill.tz_label);
    bumpCounter(locations, kill.location_label);

    collectMemberFromKill(args, kill, metrics, members, graphNodes, graphEdges);
    graphNodes.set(`system:${systemId}`, {
      id: `system:${systemId}`,
      kind: 'system',
      label: systemName,
      weight: 1,
    });
  }

  graphNodes.set(`entity:${args.scope}:${args.id}`, {
    id: `entity:${args.scope}:${args.id}`,
    kind: 'entity',
    label: `${args.scope}:${args.id}`,
    weight: 1,
  });

  const adjacency = loadAdjacency(db, [...systems.keys()]);
  if (args.includeMemberAnalysis && (args.scope === 'corporation' || args.scope === 'alliance')) {
    await enrichMembersFromEntityEndpoint(db, args, members);
  }

  return {
    kills: [...deduped.values()].filter((kill) => !kill.is_npc && !kill.is_awox && typeof kill.solar_system_id === 'number' && !!kill.killmail_time),
    systems,
    regions,
    members,
    graphNodes: [...graphNodes.values()],
    graphEdges: [...graphEdges.values()],
    adjacency,
    timezones,
    locations,
    npcSystems,
    soloLossSystems,
    filtered,
    sourceWindowDays,
  };
}

async function resolveEntityName(db: Db, scope: OsintScope, id: number): Promise<string | null> {
  const endpointScope = scope === 'character'
    ? 'characters'
    : scope === 'corporation'
      ? 'corporations'
      : 'alliances';
  const result = await getEntityDetail(db, endpointScope, id);
  if (result.ok && result.data && typeof result.data === 'object') {
    const name = (result.data as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim().length > 0) return name;
  }

  const fallback = await callEsiOperation<Array<{ id: number; name: string }>>(
    db,
    'post_universe_names',
    { ids: JSON.stringify([id]) },
  );
  if (!fallback.ok || !Array.isArray(fallback.data)) return null;
  return fallback.data.find((entry) => entry.id === id)?.name ?? null;
}

function resolveSystemRegion(db: Db, systemId: number): { regionId: number | null; regionName: string | null } {
  const row = db.prepare(`
    SELECT r.region_id AS region_id, r.name AS region_name
    FROM sde_systems s
    LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    LEFT JOIN sde_regions r ON r.region_id = c.region_id
    WHERE s.system_id = ?
  `).get(systemId) as { region_id: number | null; region_name: string | null } | undefined;
  return {
    regionId: row?.region_id ?? null,
    regionName: row?.region_name ?? null,
  };
}

function resolveSystemName(db: Db, systemId: number): string | null {
  const row = db.prepare(`SELECT name FROM sde_systems WHERE system_id = ?`).get(systemId) as { name: string } | undefined;
  return row?.name ?? null;
}

function resolveSystemSecurity(db: Db, systemId: number): number | null {
  const row = db.prepare(`SELECT json_extract(data_json, '$.security') AS security FROM sde_systems WHERE system_id = ?`).get(systemId) as { security: number | null } | undefined;
  return typeof row?.security === 'number' ? row.security : null;
}

function addRegionEvidence(
  regions: Map<number, RegionMetrics>,
  regionId: number | null,
  regionName: string | null,
  systemId: number,
  dayKey: string,
  role: 'kill' | 'loss',
  weightedRecency: number,
): void {
  if (regionId === null || !regionName) return;
  const region = regions.get(regionId) ?? {
    regionId,
    regionName,
    kills: 0,
    losses: 0,
    encounters: 0,
    uniqueDays: new Set<string>(),
    systemIds: new Set<number>(),
    recentWeight: 0,
    baseScore: 0,
    finalScore: 0,
  };
  region.encounters += 1;
  region.uniqueDays.add(dayKey);
  region.systemIds.add(systemId);
  if (role === 'kill') region.kills += 1;
  else region.losses += 1;
  region.recentWeight += weightedRecency;
  regions.set(regionId, region);
}

function collectMemberFromKill(
  args: OsintInferenceArgs,
  kill: OsintKillmail,
  metrics: SystemMetrics,
  members: Map<number, MemberStats>,
  graphNodes: Map<string, GraphNode>,
  graphEdges: Map<string, GraphEdge>,
): void {
  const participants = extractParticipants(args.scope, args.id, kill);
  for (const participant of participants) {
    metrics.memberIds.add(participant.characterId);
    const current = members.get(participant.characterId) ?? {
      characterId: participant.characterId,
      name: participant.name,
      systems: new Set<string>(),
      kills: 0,
      losses: 0,
      appearances: 0,
    };
    current.systems.add(metrics.systemName);
    current.appearances += 1;
    if (participant.role === 'kill') current.kills += 1;
    if (participant.role === 'loss') current.losses += 1;
    members.set(participant.characterId, current);

    graphNodes.set(`character:${participant.characterId}`, {
      id: `character:${participant.characterId}`,
      kind: 'character',
      label: participant.name,
      weight: current.appearances,
    });
    upsertEdge(graphEdges, {
      source: `entity:${args.scope}:${args.id}`,
      target: `character:${participant.characterId}`,
      kind: 'coactivity',
      weight: 1,
    });
    upsertEdge(graphEdges, {
      source: `character:${participant.characterId}`,
      target: `system:${metrics.systemId}`,
      kind: 'activity',
      weight: 1,
    });
  }
}

function extractParticipants(
  scope: OsintScope,
  id: number,
  kill: OsintKillmail,
): Array<{ characterId: number; name: string; role: 'kill' | 'loss' }> {
  const participants = new Map<number, { characterId: number; name: string; role: 'kill' | 'loss' }>();
  if (typeof kill.victim_character_id === 'number' && matchesScope(scope, id, 'victim', kill)) {
    participants.set(kill.victim_character_id, {
      characterId: kill.victim_character_id,
      name: `character:${kill.victim_character_id}`,
      role: 'loss',
    });
  }
  for (const attacker of kill.attackers) {
    if (typeof attacker.character_id !== 'number') continue;
    if (!matchesAttackerScope(scope, id, attacker)) continue;
    participants.set(attacker.character_id, {
      characterId: attacker.character_id,
      name: `character:${attacker.character_id}`,
      role: 'kill',
    });
  }
  return [...participants.values()];
}

function matchesScope(
  scope: OsintScope,
  id: number,
  role: 'victim' | 'final_blow',
  kill: OsintKillmail,
): boolean {
  if (scope === 'character') {
    return role === 'victim' ? kill.victim_character_id === id : kill.final_blow_character_id === id;
  }
  if (scope === 'corporation') {
    return role === 'victim' ? kill.victim_corporation_id === id : kill.final_blow_corporation_id === id;
  }
  return role === 'victim' ? kill.victim_alliance_id === id : kill.final_blow_alliance_id === id;
}

function matchesAttackerScope(
  scope: OsintScope,
  id: number,
  attacker: { character_id?: number; corporation_id?: number; alliance_id?: number },
): boolean {
  if (scope === 'character') return attacker.character_id === id;
  if (scope === 'corporation') return attacker.corporation_id === id;
  return attacker.alliance_id === id;
}

function recencyWeight(time: string | undefined): number {
  if (!time) return 0;
  const ageMs = Date.now() - new Date(time).getTime();
  if (ageMs <= 0) return 1.5;
  const ageDays = ageMs / 86_400_000;
  return Number((1 / Math.max(1, ageDays)).toFixed(3));
}

function loadAdjacency(db: Db, systemIds: number[]): Map<number, Set<number>> {
  const adjacency = new Map<number, Set<number>>();
  if (systemIds.length === 0) return adjacency;

  const placeholders = systemIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT system_id, destination_system_id
    FROM sde_stargates
    WHERE system_id IN (${placeholders}) OR destination_system_id IN (${placeholders})
  `).all(...systemIds, ...systemIds) as Array<{ system_id: number; destination_system_id: number }>;

  for (const row of rows) {
    if (!adjacency.has(row.system_id)) adjacency.set(row.system_id, new Set<number>());
    if (!adjacency.has(row.destination_system_id)) adjacency.set(row.destination_system_id, new Set<number>());
    adjacency.get(row.system_id)?.add(row.destination_system_id);
    adjacency.get(row.destination_system_id)?.add(row.system_id);
  }

  return adjacency;
}

async function enrichMembersFromEntityEndpoint(
  db: Db,
  args: OsintInferenceArgs,
  members: Map<number, MemberStats>,
): Promise<void> {
  const result = await getEntityMembers(
    db,
    args.scope === 'corporation' ? 'corporations' : 'alliances',
    args.id,
    1,
    100,
  );
  if (!result.ok || !Array.isArray(result.data)) return;

  for (const entry of result.data) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const idValue = record.character_id ?? record.id ?? record.member_id;
    if (typeof idValue !== 'number') continue;
    const current = members.get(idValue) ?? {
      characterId: idValue,
      name: typeof record.character_name === 'string'
        ? record.character_name
        : typeof record.name === 'string'
          ? record.name
          : `character:${idValue}`,
      systems: new Set<string>(),
      kills: 0,
      losses: 0,
      appearances: 0,
    };
    members.set(idValue, current);
  }
}

function scoreSystems(
  systems: Map<number, SystemMetrics>,
  regions: Map<number, RegionMetrics>,
  adjacency: Map<number, Set<number>>,
): void {
  scoreRegions(regions);

  for (const metrics of systems.values()) {
    metrics.hubPenalty = HUB_SYSTEMS.has(metrics.systemName.toLowerCase()) ? 0.22 : 0;
  }

  for (const metrics of systems.values()) {
    const neighbors = adjacency.get(metrics.systemId) ?? new Set<number>();
    let support = 0;
    for (const neighborId of neighbors) {
      const neighbor = systems.get(neighborId);
      if (!neighbor) continue;
      support += neighbor.uniqueDays.size * 0.4 + neighbor.kills * 0.15 + neighbor.losses * 0.2;
      metrics.memberIds = new Set([...metrics.memberIds, ...neighbor.memberIds]);
    }
    const regionScore = metrics.regionId !== null ? (regions.get(metrics.regionId)?.finalScore ?? 0) : 0;
    const singleDayPenalty = metrics.uniqueDays.size <= 1
      ? (regionScore >= 4.5 && metrics.encounters >= 4 && metrics.totalValue >= MIN_VALUE_FOR_SPIKE_TRUST ? 0.86 : 0.45)
      : 1;
    const valueScore = Math.min(3.4, Math.log10(Math.max(1, metrics.totalValue)) - 6);
    metrics.adjacencySupport = Number(support.toFixed(3));
    metrics.baseScore = (
      metrics.uniqueDays.size * 2.3
      + metrics.losses * 1.8
      + metrics.kills * 1.05
      + metrics.recentWeight * 1.2
      + Math.min(4, metrics.memberIds.size) * 0.8
      + Math.min(5, regionScore) * 1.25
      + Math.max(0, valueScore)
      + Math.min(1.5, metrics.soloEncounters * 0.25)
    );
    metrics.finalScore = Number(Math.max(
      0,
      (metrics.baseScore + metrics.adjacencySupport - metrics.hubPenalty * 6) * singleDayPenalty,
    ).toFixed(3));
  }
}

function scoreRegions(regions: Map<number, RegionMetrics>): void {
  for (const region of regions.values()) {
    region.baseScore = (
      region.uniqueDays.size * 2.4
      + region.losses * 1.4
      + region.kills * 0.95
      + region.recentWeight * 1.1
      + Math.min(6, region.systemIds.size) * 0.45
    );
    region.finalScore = Number(region.baseScore.toFixed(3));
  }
}

function buildHypotheses(evidence: CollectedEvidence): Array<Record<string, unknown>> {
  const ranked = selectCandidateSystems(evidence).slice(0, 3);
  const maxScore = ranked[0]?.finalScore ?? 1;
  const spread = ranked.length >= 2 ? Math.max(0, ranked[0].finalScore - ranked[1].finalScore) : ranked[0]?.finalScore ?? 0;

  return ranked.map((metrics, index) => {
    const kind: HypothesisKind = inferKind(metrics, index === 0 && spread > 1.5);
    const confidence = normalizeConfidence(metrics.finalScore, maxScore, metrics.uniqueDays.size, metrics.hubPenalty);
    return {
      kind,
      system_id: metrics.systemId,
      system_name: metrics.systemName,
      region_id: metrics.regionId,
      region_name: metrics.regionName,
      confidence,
      score: metrics.finalScore,
      reasons: buildReasons(metrics),
    };
  });
}

function inferKind(metrics: SystemMetrics, dominantTop: boolean): HypothesisKind {
  if (metrics.losses >= metrics.kills && dominantTop) return 'home_system';
  if (metrics.kills > metrics.losses * 1.4) return 'hunting_area';
  return 'staging_system';
}

function normalizeConfidence(score: number, maxScore: number, uniqueDays: number, hubPenalty: number): number {
  const ratio = maxScore > 0 ? score / maxScore : 0;
  const stabilityBoost = Math.min(0.2, uniqueDays * 0.03);
  const penalty = hubPenalty * 0.5;
  return Number(Math.max(0.15, Math.min(0.97, ratio * 0.72 + stabilityBoost - penalty)).toFixed(2));
}

function buildReasons(metrics: SystemMetrics): string[] {
  const reasons = [
    `${metrics.uniqueDays.size} unique activity days in system`,
    `${metrics.losses.toFixed(1)} losses vs ${metrics.kills.toFixed(1)} kills`,
  ];
  if (metrics.regionName) {
    reasons.push(`system sits inside an active region cluster: ${metrics.regionName}`);
  }
  if (metrics.adjacencySupport > 0.5) {
    reasons.push(`activity spills into adjacent systems (+${metrics.adjacencySupport.toFixed(1)} adjacency support)`);
  }
  if (metrics.memberIds.size > 0) {
    reasons.push(`${metrics.memberIds.size} core members repeatedly appear here`);
  }
  if (metrics.totalValue > 0) {
    reasons.push(`${(metrics.totalValue / 1_000_000_000).toFixed(2)}B ISK of filtered activity`);
  }
  const dominantTimezone = dominantLabel(metrics.timezones);
  if (dominantTimezone) {
    reasons.push(`dominant timezone signal: ${dominantTimezone}`);
  }
  if (metrics.hubPenalty > 0) {
    reasons.push('trade-hub/chokepoint penalty applied');
  }
  return reasons;
}

function buildCluster(
  systems: Map<number, SystemMetrics>,
  adjacency: Map<number, Set<number>>,
): Record<string, unknown> | null {
  const ranked = [...systems.values()].sort((a, b) => b.finalScore - a.finalScore);
  const anchor = ranked[0];
  if (!anchor) return null;
  const clusterSystems = [anchor.systemName];
  const neighbors = adjacency.get(anchor.systemId) ?? new Set<number>();
  for (const neighborId of neighbors) {
    const metrics = systems.get(neighborId);
    if (!metrics) continue;
    if (metrics.finalScore >= anchor.finalScore * 0.45) {
      clusterSystems.push(metrics.systemName);
    }
  }
  return {
    anchor_system_id: anchor.systemId,
    anchor_system_name: anchor.systemName,
    systems: clusterSystems.slice(0, 4),
    core_systems: clusterSystems.slice(0, 4),
    radius_jumps: clusterSystems.length > 1 ? 1 : 0,
    score: Number((anchor.finalScore + clusterSystems.length * 0.4).toFixed(2)),
  };
}

function selectCandidateSystems(evidence: CollectedEvidence): SystemMetrics[] {
  const topRegionIds = [...evidence.regions.values()]
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 3)
    .map((region) => region.regionId);

  const filtered = [...evidence.systems.values()]
    .filter((system) => system.regionId !== null && topRegionIds.includes(system.regionId))
    .sort((a, b) => b.finalScore - a.finalScore);

  return filtered.length > 0
    ? filtered
    : [...evidence.systems.values()].sort((a, b) => b.finalScore - a.finalScore);
}

async function buildMemberSummary(db: Db, members: Map<number, MemberStats>): Promise<Array<Record<string, unknown>>> {
  const top = [...members.values()]
    .sort((a, b) => (b.appearances + b.kills * 0.5 + b.losses * 0.75) - (a.appearances + a.kills * 0.5 + a.losses * 0.75))
    .slice(0, 5);
  const resolvedNames = await resolveCharacterNames(db, top.map((member) => member.characterId));
  return top.map((member) => ({
    character_id: member.characterId,
    character_name: resolvedNames.get(member.characterId) ?? member.name,
    event_count: member.appearances,
    top_systems: [...member.systems].slice(0, 3),
    overlap_score: Number(Math.min(1, (member.appearances + member.kills * 0.35 + member.losses * 0.5) / 4).toFixed(2)),
  }));
}

async function resolveCharacterNames(db: Db, ids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (ids.length === 0) return result;
  const response = await callEsiOperation<Array<{ id: number; name: string }>>(
    db,
    'post_universe_names',
    { ids: JSON.stringify(ids.slice(0, 100)) },
  );
  if (!response.ok || !Array.isArray(response.data)) return result;
  for (const entry of response.data) {
    if (typeof entry.id === 'number' && typeof entry.name === 'string') {
      result.set(entry.id, entry.name);
    }
  }
  return result;
}

function buildGraphDigest(
  args: OsintInferenceArgs,
  evidence: CollectedEvidence,
  cluster: Record<string, unknown> | null,
  memberSummary: Array<Record<string, unknown>>,
): GraphDigest {
  const topRegions = [...evidence.regions.values()]
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 5)
    .map((region) => ({
      region_id: region.regionId,
      region_name: region.regionName,
      score: region.finalScore,
      unique_days: region.uniqueDays.size,
      systems_seen: region.systemIds.size,
      kills: region.kills,
      losses: region.losses,
    }));
  const topSystems = selectCandidateSystems(evidence)
    .slice(0, MAX_GRAPH_SYSTEMS)
    .map((metrics) => ({
      system_id: metrics.systemId,
      system_name: metrics.systemName,
      region_name: metrics.regionName,
      score: metrics.finalScore,
      unique_days: metrics.uniqueDays.size,
      kills: metrics.kills,
      losses: metrics.losses,
      total_value_b: Number((metrics.totalValue / 1_000_000_000).toFixed(2)),
      member_overlap: metrics.memberIds.size,
      hub_penalty: metrics.hubPenalty,
      adjacency_support: metrics.adjacencySupport,
      dominant_timezone: dominantLabel(metrics.timezones),
      location_profile: dominantLabel(metrics.locations),
    }));

  return {
    entity: { scope: args.scope, id: args.id },
    window_days: args.windowDays,
    kill_count: evidence.kills.length,
    top_regions: topRegions,
    top_systems: topSystems,
    clusters: cluster ? [cluster] : [],
    core_members: memberSummary.slice(0, MAX_GRAPH_MEMBERS),
    signals: {
      split_theater: computeSplitTheater(topSystems),
      roaming_bias: computeRoamingBias(topSystems),
      hub_bias: Number(topSystems.reduce((sum, item) => sum + Number(item.hub_penalty ?? 0), 0).toFixed(2)),
      member_concentration: computeMemberConcentration(topSystems),
      timezone_dispersion: computeCounterDispersion(evidence.timezones),
      single_day_spike_bias: computeSingleDaySpikeBias(evidence.systems),
      nullsec_bias: computeLocationBias(evidence.locations, 'nullsec'),
      lowsec_bias: computeLocationBias(evidence.locations, 'lowsec'),
      graph_node_count: Math.min(MAX_GRAPH_SYSTEMS + MAX_GRAPH_MEMBERS, evidence.graphNodes.length),
      graph_edge_count: Math.min(20, evidence.graphEdges.length),
    },
  };
}

function computeSplitTheater(topSystems: Array<Record<string, unknown>>): number {
  if (topSystems.length < 2) return 0;
  const first = Number(topSystems[0].score ?? 0);
  const second = Number(topSystems[1].score ?? 0);
  if (first <= 0) return 0;
  return Number(Math.max(0, Math.min(1, second / first)).toFixed(2));
}

function computeRoamingBias(topSystems: Array<Record<string, unknown>>): number {
  if (topSystems.length === 0) return 0;
  const kills = topSystems.reduce((sum, item) => sum + Number(item.kills ?? 0), 0);
  const losses = topSystems.reduce((sum, item) => sum + Number(item.losses ?? 0), 0);
  if (kills + losses === 0) return 0;
  return Number((kills / (kills + losses)).toFixed(2));
}

function computeMemberConcentration(topSystems: Array<Record<string, unknown>>): number {
  if (topSystems.length === 0) return 0;
  const overlap = topSystems.map((item) => Number(item.member_overlap ?? 0));
  const max = Math.max(...overlap, 0);
  const avg = overlap.reduce((sum, value) => sum + value, 0) / overlap.length;
  if (max === 0) return 0;
  return Number((avg / max).toFixed(2));
}

function mergeUncertainty(
  args: OsintInferenceArgs,
  evidence: CollectedEvidence,
  hypotheses: Array<Record<string, unknown>>,
  llmPatternAnalysis: Record<string, unknown> | null,
): string[] {
  const items = [
    'Killboard activity is only a proxy for residence and staging.',
  ];
  if (evidence.sourceWindowDays < args.windowDays) {
    items.push(`zKill scoped feed is capped to ${evidence.sourceWindowDays} day(s) by upstream API limits.`);
  }
  if (hypotheses.length > 1) {
    items.push('Top systems are close in score, so the theater may be split or roaming.');
  }
  if (evidence.kills.length < 12) {
    items.push('Evidence sample is small, so confidence is capped.');
  }
  if ([...evidence.systems.values()].some((entry) => entry.uniqueDays.size <= 1)) {
    items.push('Single-day spikes are down-weighted, but some top systems may still reflect transient operations.');
  }
  if (evidence.filtered.npc > 0 || evidence.filtered.awox > 0) {
    items.push('NPC and awox rows were excluded from scoring to reduce noise.');
  }
  if (evidence.filtered.incomplete > 0) {
    items.push('Some killmails were skipped because zKill/ESI enrichment did not expose enough location data.');
  }
  if (!llmPatternAnalysis) {
    items.push('LLM graph pattern analysis unavailable or skipped; result is deterministic-only.');
  }
  return items;
}

function buildHomeHypothesis(
  db: Db,
  evidence: CollectedEvidence,
  returnHubs: Array<{ system_id: number; system_name: string; hub_score: number; in_degree: number; return_count: number }>,
): Array<Record<string, unknown>> {
  const candidates = new Map<number, {
    systemId: number; systemName: string; regionName: string | null;
    npcScore: number; soloLossScore: number; hubScore: number;
    weeklyStability: number; totalScore: number;
    reasons: string[];
  }>();

  const allSystemIds = new Set([
    ...evidence.npcSystems.keys(),
    ...evidence.soloLossSystems.keys(),
    ...returnHubs.map((h) => h.system_id),
  ]);

  for (const systemId of allSystemIds) {
    const systemName = resolveSystemName(db, systemId) ?? `system:${systemId}`;
    const { regionName } = resolveSystemRegion(db, systemId);
    const reasons: string[] = [];

    const npc = evidence.npcSystems.get(systemId);
    const npcScore = npc ? npc.uniqueDays.size * 3.0 + npc.count * 0.8 : 0;
    if (npc) reasons.push(`${npc.count} NPC kills across ${npc.uniqueDays.size} days (ratting activity)`);

    const solo = evidence.soloLossSystems.get(systemId);
    const soloLossScore = solo ? solo.uniqueDays.size * 2.5 + solo.count * 1.5 : 0;
    if (solo) reasons.push(`${solo.count} solo losses (caught during PvE)`);

    const hub = returnHubs.find((h) => h.system_id === systemId);
    const hubScore = hub ? hub.hub_score * 1.2 : 0;
    if (hub) reasons.push(`return hub: ${hub.in_degree} source systems, ${hub.return_count} returns`);

    const pvpSystem = evidence.systems.get(systemId);
    const allDays = new Set<string>();
    if (npc) for (const d of npc.uniqueDays) allDays.add(d);
    if (solo) for (const d of solo.uniqueDays) allDays.add(d);
    if (pvpSystem) for (const d of pvpSystem.uniqueDays) allDays.add(d);
    const sortedDays = [...allDays].sort();
    let weeklyStability = 0;
    if (sortedDays.length >= 2) {
      const weeks = new Set(sortedDays.map((d) => {
        const date = new Date(d);
        const yearDay = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / 86_400_000);
        return `${date.getFullYear()}-W${Math.floor(yearDay / 7)}`;
      }));
      weeklyStability = Math.min(1, weeks.size / Math.max(1, evidence.sourceWindowDays / 7));
      if (weeks.size >= 2) reasons.push(`active ${weeks.size} weeks (stable presence)`);
    }

    const totalScore = npcScore + soloLossScore + hubScore + weeklyStability * 2.0;
    if (totalScore < 1) continue;

    candidates.set(systemId, {
      systemId, systemName, regionName,
      npcScore, soloLossScore, hubScore, weeklyStability, totalScore, reasons,
    });
  }

  const ranked = [...candidates.values()].sort((a, b) => b.totalScore - a.totalScore).slice(0, 3);
  if (ranked.length === 0) return [];

  const maxScore = ranked[0].totalScore;
  return ranked.map((c) => ({
    kind: 'home_system' as const,
    system_id: c.systemId,
    system_name: c.systemName,
    region_name: c.regionName,
    confidence: Number(Math.max(0.15, Math.min(0.95, (c.totalScore / maxScore) * 0.7 + c.weeklyStability * 0.2)).toFixed(2)),
    score: Number(c.totalScore.toFixed(2)),
    signals: {
      npc_score: Number(c.npcScore.toFixed(2)),
      solo_loss_score: Number(c.soloLossScore.toFixed(2)),
      hub_score: Number(c.hubScore.toFixed(2)),
      weekly_stability: Number(c.weeklyStability.toFixed(2)),
    },
    reasons: c.reasons,
  }));
}

function emptyGraphDigest(args: OsintInferenceArgs): GraphDigest {
  return {
    entity: { scope: args.scope, id: args.id },
    window_days: args.windowDays,
    kill_count: 0,
    top_regions: [],
    top_systems: [],
    clusters: [],
    core_members: [],
    signals: {
      split_theater: 0,
      roaming_bias: 0,
      hub_bias: 0,
      member_concentration: 0,
      timezone_dispersion: 0,
      single_day_spike_bias: 0,
      nullsec_bias: 0,
      lowsec_bias: 0,
      graph_node_count: 0,
      graph_edge_count: 0,
    },
  };
}

function upsertEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
  const key = `${edge.source}|${edge.target}|${edge.kind}`;
  const current = edges.get(key);
  if (current) {
    current.weight += edge.weight;
    return;
  }
  edges.set(key, { ...edge });
}

function computeValueWeight(totalValue: number | undefined): number {
  if (!totalValue || totalValue <= 0) return 0.95;
  return Math.max(0.85, Math.min(1.35, 0.85 + Math.log10(totalValue) / 12));
}

function bumpCounter(counter: Map<string, number>, key: string | null): void {
  if (!key) return;
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function dominantLabel(counter: Map<string, number>): string | null {
  let best: string | null = null;
  let score = -1;
  for (const [label, count] of counter.entries()) {
    if (count > score) {
      best = label;
      score = count;
    }
  }
  return best;
}

function computeCounterDispersion(counter: Map<string, number>): number {
  const values = [...counter.values()].sort((a, b) => b - a);
  if (values.length < 2) return 0;
  return Number(Math.min(1, values[1] / values[0]).toFixed(2));
}

function computeSingleDaySpikeBias(systems: Map<number, SystemMetrics>): number {
  const values = [...systems.values()];
  if (values.length === 0) return 0;
  const singleDay = values.filter((entry) => entry.uniqueDays.size <= 1).length;
  return Number((singleDay / values.length).toFixed(2));
}

function computeLocationBias(counter: Map<string, number>, label: string): number {
  const total = [...counter.values()].reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  return Number(((counter.get(label) ?? 0) / total).toFixed(2));
}
