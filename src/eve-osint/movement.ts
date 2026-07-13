import type { Db } from '../db/sqlite.js';
import type { OsintKillmail } from './zkill.js';

export type MovementProfile = {
  routes: Array<{
    from_system: string;
    to_system: string;
    count: number;
  }>;
  travel_pipes: string[][];
  unique_systems: number;
  geographic_spread: number;
};

export type ReturnHubProfile = {
  hubs: Array<{
    system_id: number;
    system_name: string;
    in_degree: number;
    return_count: number;
    hub_score: number;
  }>;
};

export type DeploymentProfile = {
  deployments: Array<{
    from_region: string;
    to_region: string;
    start_date: string;
    end_date: string | null;
    duration_days: number;
    is_current: boolean;
  }>;
  current_region: string | null;
  region_stability: number;
  moves_count: number;
};

type SystemInfo = { system_name: string; region_id: number | null; region_name: string | null };

function resolveSystemsBatch(db: Db, systemIds: number[]): Map<number, SystemInfo> {
  const result = new Map<number, SystemInfo>();
  if (systemIds.length === 0) return result;

  const placeholders = systemIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT s.system_id, s.name AS system_name, r.region_id, r.name AS region_name
    FROM sde_systems s
    LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    LEFT JOIN sde_regions r ON r.region_id = c.region_id
    WHERE s.system_id IN (${placeholders})
  `).all(...systemIds) as Array<{
    system_id: number;
    system_name: string;
    region_id: number | null;
    region_name: string | null;
  }>;

  for (const row of rows) {
    result.set(row.system_id, {
      system_name: row.system_name,
      region_id: row.region_id,
      region_name: row.region_name,
    });
  }
  return result;
}

function sortByTime(kills: OsintKillmail[]): OsintKillmail[] {
  // Drop unparseable timestamps — a NaN comparator key gives implementation-
  // defined ordering, which breaks the deterministic-output guarantee.
  return [...kills]
    .filter((k) => k.killmail_time && k.solar_system_id && Number.isFinite(new Date(k.killmail_time).getTime()))
    .sort((a, b) => new Date(a.killmail_time!).getTime() - new Date(b.killmail_time!).getTime());
}

function collectSystemIds(kills: OsintKillmail[]): number[] {
  const ids = new Set<number>();
  for (const k of kills) {
    if (k.solar_system_id != null) ids.add(k.solar_system_id);
  }
  return [...ids];
}

export function analyzeMovement(db: Db, kills: OsintKillmail[]): MovementProfile {
  const empty: MovementProfile = { routes: [], travel_pipes: [], unique_systems: 0, geographic_spread: 0 };
  const sorted = sortByTime(kills);
  if (sorted.length === 0) return empty;

  const systemIds = collectSystemIds(sorted);
  const sdeMap = resolveSystemsBatch(db, systemIds);

  const transitionCounts = new Map<string, number>();
  const adjacency = new Map<number, Map<number, number>>();

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].solar_system_id!;
    const curr = sorted[i].solar_system_id!;
    if (prev === curr) continue;

    const key = `${prev}→${curr}`;
    transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);

    if (!adjacency.has(prev)) adjacency.set(prev, new Map());
    const neighbors = adjacency.get(prev)!;
    neighbors.set(curr, (neighbors.get(curr) ?? 0) + 1);
  }

  const routes = [...transitionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([key, count]) => {
      const [fromStr, toStr] = key.split('→');
      const fromId = Number(fromStr);
      const toId = Number(toStr);
      return {
        from_system: sdeMap.get(fromId)?.system_name ?? `System ${fromId}`,
        to_system: sdeMap.get(toId)?.system_name ?? `System ${toId}`,
        count,
      };
    });

  const travel_pipes = findTravelPipes(adjacency, sdeMap);

  const regionIds = new Set<number>();
  for (const info of sdeMap.values()) {
    if (info.region_id != null) regionIds.add(info.region_id);
  }

  return {
    routes,
    travel_pipes,
    unique_systems: systemIds.length,
    geographic_spread: regionIds.size,
  };
}

function findTravelPipes(
  adjacency: Map<number, Map<number, number>>,
  sdeMap: Map<number, SystemInfo>,
): string[][] {
  const MIN_FREQ = 2;
  const frequentEdges = new Map<number, Set<number>>();

  for (const [from, neighbors] of adjacency) {
    for (const [to, count] of neighbors) {
      if (count < MIN_FREQ) continue;
      if (!frequentEdges.has(from)) frequentEdges.set(from, new Set());
      frequentEdges.get(from)!.add(to);
    }
  }

  const chains: number[][] = [];
  const visited = new Set<string>();

  for (const start of frequentEdges.keys()) {
    const chain = [start];
    let current = start;

    while (true) {
      const next = frequentEdges.get(current);
      if (!next) break;

      let best: number | null = null;
      let bestCount = 0;
      for (const candidate of next) {
        if (chain.includes(candidate)) continue;
        const count = adjacency.get(current)?.get(candidate) ?? 0;
        if (count > bestCount) {
          best = candidate;
          bestCount = count;
        }
      }
      if (best == null) break;
      chain.push(best);
      current = best;
    }

    if (chain.length >= 3) {
      const sig = chain.join('-');
      if (!visited.has(sig)) {
        visited.add(sig);
        chains.push(chain);
      }
    }
  }

  const scoredChains = chains
    .map((chain) => {
      let score = 0;
      for (let i = 0; i < chain.length - 1; i++) {
        score += adjacency.get(chain[i])?.get(chain[i + 1]) ?? 0;
      }
      return { chain, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return scoredChains.map(({ chain }) =>
    chain.map((id) => sdeMap.get(id)?.system_name ?? `System ${id}`),
  );
}

export function detectDeployments(db: Db, kills: OsintKillmail[]): DeploymentProfile {
  const empty: DeploymentProfile = { deployments: [], current_region: null, region_stability: 0, moves_count: 0 };
  const sorted = sortByTime(kills);
  if (sorted.length === 0) return empty;

  const systemIds = collectSystemIds(sorted);
  const sdeMap = resolveSystemsBatch(db, systemIds);

  const dailyRegions = new Map<string, Map<string, number>>();

  for (const kill of sorted) {
    const info = sdeMap.get(kill.solar_system_id!);
    if (!info?.region_name) continue;

    const day = kill.killmail_time!.slice(0, 10);
    if (!dailyRegions.has(day)) dailyRegions.set(day, new Map());
    const regionCounts = dailyRegions.get(day)!;
    regionCounts.set(info.region_name, (regionCounts.get(info.region_name) ?? 0) + 1);
  }

  const days = [...dailyRegions.keys()].sort();
  if (days.length === 0) return empty;

  const dominantPerDay = new Map<string, string>();
  for (const day of days) {
    const regions = dailyRegions.get(day)!;
    let best = '';
    let bestCount = 0;
    for (const [region, count] of regions) {
      if (count > bestCount) {
        best = region;
        bestCount = count;
      }
    }
    dominantPerDay.set(day, best);
  }

  const PERSIST_THRESHOLD = 3;
  const deployments: DeploymentProfile['deployments'] = [];
  let currentRegion = dominantPerDay.get(days[0])!;
  let streakRegion = currentRegion;
  let streakStart = days[0];
  let streakDays = 1;

  for (let i = 1; i < days.length; i++) {
    const dayRegion = dominantPerDay.get(days[i])!;

    if (dayRegion === streakRegion) {
      streakDays += 1;
    } else {
      if (streakRegion !== currentRegion && streakDays >= PERSIST_THRESHOLD) {
        deployments.push({
          from_region: currentRegion,
          to_region: streakRegion,
          start_date: streakStart,
          end_date: days[i - 1],
          duration_days: streakDays,
          is_current: false,
        });
        currentRegion = streakRegion;
      }
      streakRegion = dayRegion;
      streakStart = days[i];
      streakDays = 1;
    }
  }

  if (streakRegion !== currentRegion && streakDays >= PERSIST_THRESHOLD) {
    deployments.push({
      from_region: currentRegion,
      to_region: streakRegion,
      start_date: streakStart,
      end_date: null,
      duration_days: streakDays,
      is_current: true,
    });
    currentRegion = streakRegion;
  } else if (deployments.length > 0) {
    const last = deployments[deployments.length - 1];
    if (last.end_date === null) {
      last.is_current = true;
    }
  }

  const last7days = days.slice(-7);
  const recentRegionCounts = new Map<string, number>();
  for (const day of last7days) {
    const region = dominantPerDay.get(day)!;
    recentRegionCounts.set(region, (recentRegionCounts.get(region) ?? 0) + 1);
  }
  let currentRegionResult: string | null = null;
  let maxRecent = 0;
  for (const [region, count] of recentRegionCounts) {
    if (count > maxRecent) {
      currentRegionResult = region;
      maxRecent = count;
    }
  }

  const overallRegionCounts = new Map<string, number>();
  for (const day of days) {
    const region = dominantPerDay.get(day)!;
    overallRegionCounts.set(region, (overallRegionCounts.get(region) ?? 0) + 1);
  }
  let dominantCount = 0;
  for (const count of overallRegionCounts.values()) {
    if (count > dominantCount) dominantCount = count;
  }
  const region_stability = days.length > 0 ? dominantCount / days.length : 0;

  return {
    deployments,
    current_region: currentRegionResult,
    region_stability: Math.round(region_stability * 100) / 100,
    moves_count: deployments.length,
  };
}

export function detectReturnHubs(db: Db, kills: OsintKillmail[]): ReturnHubProfile {
  const empty: ReturnHubProfile = { hubs: [] };
  const sorted = sortByTime(kills);
  if (sorted.length < 2) return empty;

  // Build transition graph: for each consecutive pair in different systems,
  // record {from_system → to_system}
  const incomingSources = new Map<number, Set<number>>();  // target → set of unique sources
  const incomingCounts = new Map<number, number>();         // target → total incoming transitions

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].solar_system_id!;
    const curr = sorted[i].solar_system_id!;
    if (prev === curr) continue;

    if (!incomingSources.has(curr)) incomingSources.set(curr, new Set());
    incomingSources.get(curr)!.add(prev);
    incomingCounts.set(curr, (incomingCounts.get(curr) ?? 0) + 1);
  }

  // Score each system
  const scored: Array<{ system_id: number; in_degree: number; return_count: number; hub_score: number }> = [];

  for (const [systemId, sources] of incomingSources) {
    const in_degree = sources.size;
    if (in_degree < 2) continue; // need at least 2 different source systems
    const return_count = incomingCounts.get(systemId) ?? 0;
    const hub_score = in_degree * Math.log2(return_count + 1);
    scored.push({ system_id: systemId, in_degree, return_count, hub_score });
  }

  scored.sort((a, b) => b.hub_score - a.hub_score);
  const top = scored.slice(0, 5);

  if (top.length === 0) return empty;

  // Resolve system names
  const systemIds = collectSystemIds(kills);
  const sdeMap = resolveSystemsBatch(db, systemIds);

  return {
    hubs: top.map((s) => ({
      system_id: s.system_id,
      system_name: sdeMap.get(s.system_id)?.system_name ?? `System ${s.system_id}`,
      in_degree: s.in_degree,
      return_count: s.return_count,
      hub_score: Math.round(s.hub_score * 100) / 100,
    })),
  };
}
