import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from './esi-client.js';
import { executeZkillQuery } from './zkill-query.js';
import { getLinkedCharacter, getAccessToken } from './sso.js';

type RouteFlag = 'secure' | 'shortest' | 'insecure';

type SystemInfo = {
  id: number;
  name: string;
  sec: number;
  region: string;
};

type SystemKillEntry = {
  system_id: number;
  ship_kills: number;
  npc_kills: number;
  pod_kills: number;
};

type HotspotKill = {
  time: string | null;
  victim: string | null;
  victim_ship: string | null;
  attacker: string | null;
  attacker_ship: string | null;
  value_m: number | null;
  url: string;
};

type Hotspot = {
  name: string;
  id: number;
  sec: number;
  ship_kills: number;
  pod_kills: number;
  danger_score: number;
  recent_kills?: HotspotKill[];
};

type RouteVariant = {
  flag: RouteFlag;
  jumps: number;
  min_sec: number;
  total_ship_kills: number;
  total_pod_kills: number;
  danger_score: number;
  hotspots: Hotspot[];
  systems: string[];
};

export type PlanRouteResult = {
  ok: boolean;
  origin: SystemInfo | null;
  destination: SystemInfo | null;
  routes: RouteVariant[];
  autopilot_set: boolean;
  error: string | null;
};

export type PlanRouteArgs = {
  origin: string;
  destination: string;
  set_autopilot?: boolean;
  avoid?: number[];
  prefer?: RouteFlag;
};

// Kill stats cache (shared with system_kill_stats tool)
let killStatsCache: { data: SystemKillEntry[]; fetchedAt: number } | null = null;
const KILL_STATS_TTL_MS = 5 * 60 * 1000;

export async function fetchKillStats(): Promise<SystemKillEntry[]> {
  const now = Date.now();
  if (killStatsCache && now - killStatsCache.fetchedAt < KILL_STATS_TTL_MS) {
    return killStatsCache.data;
  }
  const res = await fetch('https://esi.evetech.net/latest/universe/system_kills/?datasource=tranquility', {
    headers: { 'User-Agent': 'eve-agent/0.1.0' },
  });
  if (!res.ok) return killStatsCache?.data ?? [];
  const data = await res.json() as SystemKillEntry[];
  killStatsCache = { data, fetchedAt: now };
  return data;
}

export function filterKillStats(allKills: SystemKillEntry[], systemIds: Set<number>): Map<number, SystemKillEntry> {
  const map = new Map<number, SystemKillEntry>();
  for (const entry of allKills) {
    if (systemIds.has(entry.system_id)) {
      map.set(entry.system_id, entry);
    }
  }
  return map;
}

export async function planRoute(db: Db, args: PlanRouteArgs, chatId: number): Promise<PlanRouteResult> {
  // 1. Resolve origin & destination — "current" uses live location
  const originInput = args.origin.toLowerCase() === 'current'
    ? resolveCurrentSystem(db, chatId)
    : args.origin;
  const originInfo = resolveSystem(db, originInput ?? args.origin);
  const destInfo = resolveSystem(db, args.destination);

  if (!originInfo) {
    return { ok: false, origin: null, destination: null, routes: [], autopilot_set: false, error: `Unknown origin system: ${args.origin}` };
  }
  if (!destInfo) {
    return { ok: false, origin: originInfo, destination: null, routes: [], autopilot_set: false, error: `Unknown destination system: ${args.destination}` };
  }

  // 2. Fetch routes (all 3 variants) + kill stats in parallel
  const flags: RouteFlag[] = ['secure', 'shortest', 'insecure'];
  const [routeResults, allKills] = await Promise.all([
    Promise.all(flags.map((flag) => fetchRoute(db, originInfo.id, destInfo.id, flag, args.avoid ?? [], chatId))),
    fetchKillStats(),
  ]);

  // 3. Collect all unique system IDs across all routes
  const allSystemIds = new Set<number>();
  for (const route of routeResults) {
    if (route) for (const id of route) allSystemIds.add(id);
  }

  // 4. Resolve system info from SDE + filter kill stats
  const systemInfoMap = resolveSystemBatch(db, allSystemIds);
  const killMap = filterKillStats(allKills, allSystemIds);

  // 5. Build route variants
  const routes: RouteVariant[] = [];
  for (let i = 0; i < flags.length; i++) {
    const systemIds = routeResults[i];
    if (!systemIds || systemIds.length === 0) continue;

    // Deduplicate (same route as another flag)
    const key = systemIds.join(',');
    if (routes.some((r) => r.systems.join(',') === systemInfoMap ? false : false)) {
      // just build it, dedup at the end
    }

    const variant = buildRouteVariant(flags[i], systemIds, systemInfoMap, killMap);
    // Skip duplicate routes
    const isDuplicate = routes.some((r) => r.jumps === variant.jumps && r.systems.join(',') === variant.systems.join(','));
    if (!isDuplicate) {
      routes.push(variant);
    }
  }

  // 5.5. Enrich hotspots with recent kills — adaptive by danger_score
  const allHotspots = routes.flatMap((r) => r.hotspots);
  const uniqueHotspots = new Map<number, Hotspot>();
  for (const h of allHotspots) {
    if (!uniqueHotspots.has(h.id) || h.danger_score > (uniqueHotspots.get(h.id)?.danger_score ?? 0)) {
      uniqueHotspots.set(h.id, h);
    }
  }

  // Adaptive: pick hotspots and detail count based on danger
  const sortedHotspots = [...uniqueHotspots.values()]
    .filter((h) => h.danger_score > 0)
    .sort((a, b) => b.danger_score - a.danger_score);

  const enrichTargets = sortedHotspots.slice(0, 3).map((h) => ({
    hotspot: h,
    detailCount: h.danger_score > 100 ? 3 : h.danger_score > 30 ? 2 : 1,
  })).filter((t) => t.hotspot.ship_kills > 0);

  if (enrichTargets.length > 0) {
    const killResults = await Promise.all(enrichTargets.map(async (t) => {
      try {
        const r = await executeZkillQuery(db, `kills/systemID/${t.hotspot.id}/pastSeconds/21600/`, t.detailCount, chatId);
        console.log('[plan_route] zkill %s: ok=%s feed=%d detailed=%d', t.hotspot.name, r.ok, r.feed_count, r.detailed.length);
        return { systemId: t.hotspot.id, kills: r.ok ? r.detailed : [] };
      } catch (err) {
        console.log('[plan_route] zkill %s error: %s', t.hotspot.name, (err as Error).message);
        return { systemId: t.hotspot.id, kills: [] as typeof enrichTargets extends Array<infer _> ? never[] : never[] };
      }
    }));

    const recentMap = new Map<number, HotspotKill[]>();
    for (const { systemId, kills } of killResults) {
      const playerKills = (kills as Array<{ time: string | null; victim_name: string | null; victim_ship: string | null; attacker_name: string | null; attacker_ship: string | null; value_m: number | null; url: string; npc: boolean }>)
        .filter((k) => !k.npc)
        .map((k): HotspotKill => ({
          time: k.time,
          victim: k.victim_name,
          victim_ship: k.victim_ship,
          attacker: k.attacker_name,
          attacker_ship: k.attacker_ship,
          value_m: k.value_m,
          url: k.url,
        }));
      if (playerKills.length > 0) recentMap.set(systemId, playerKills);
    }

    for (const route of routes) {
      for (const hotspot of route.hotspots) {
        const kills = recentMap.get(hotspot.id);
        if (kills) hotspot.recent_kills = kills;
      }
    }
    console.log('[plan_route] enriched %d hotspots, total recent_kills: %d',
      recentMap.size, [...recentMap.values()].reduce((s, k) => s + k.length, 0));
  }

  // 6. Set autopilot for the preferred route
  let autopilotSet = false;
  if (args.set_autopilot !== false && routes.length > 0) {
    const preferred = args.prefer
      ? routes.find((r) => r.flag === args.prefer) ?? routes[0]
      : routes.find((r) => r.flag === 'secure') ?? routes[0];

    // Find the system IDs for the preferred route
    const prefIndex = flags.indexOf(preferred.flag);
    const prefSystemIds = routeResults[prefIndex];
    if (prefSystemIds && prefSystemIds.length > 0) {
      try {
        // Set first waypoint as destination, clear existing route
        await callEsiOperation(db, 'post_ui_autopilot_waypoint', {
          destination_id: destInfo.id,
          clear_other_waypoints: true,
          add_to_beginning: false,
        }, chatId);
        autopilotSet = true;
      } catch {
        // UI action failed, not critical
      }
    }
  }

  return {
    ok: true,
    origin: originInfo,
    destination: destInfo,
    routes,
    autopilot_set: autopilotSet,
    error: null,
  };
}

function resolveCurrentSystem(db: Db, chatId: number): string | null {
  const linked = getLinkedCharacter(db, chatId);
  if (!linked) return null;
  const prefix = `get_characters_character_id_location:${linked.characterId}:`;
  const cached = db.prepare(
    "SELECT response_text FROM esi_cache WHERE cache_key LIKE ? LIMIT 1"
  ).get(`${prefix}%`) as { response_text: string } | undefined;
  if (cached) {
    try {
      const data = JSON.parse(cached.response_text) as { solar_system_id?: number };
      if (data.solar_system_id) return String(data.solar_system_id);
    } catch { /* fall through */ }
  }
  return null;
}

function resolveSystem(db: Db, input: string): SystemInfo | null {
  // Try as system_id first
  const asId = Number(input);
  if (Number.isFinite(asId) && asId > 0) {
    const row = db.prepare(
      "SELECT system_id, name, json_extract(data_json, '$.security') as sec, constellation_id FROM sde_systems WHERE system_id = ?"
    ).get(asId) as { system_id: number; name: string; sec: number; constellation_id: number } | undefined;
    if (row) return enrichSystemInfo(db, row);
  }

  // Try exact name match
  const byName = db.prepare(
    "SELECT system_id, name, json_extract(data_json, '$.security') as sec, constellation_id FROM sde_systems WHERE name = ? COLLATE NOCASE"
  ).get(input) as { system_id: number; name: string; sec: number; constellation_id: number } | undefined;
  if (byName) return enrichSystemInfo(db, byName);

  // Try fuzzy
  const fuzzy = db.prepare(
    "SELECT system_id, name, json_extract(data_json, '$.security') as sec, constellation_id FROM sde_systems WHERE name LIKE ? COLLATE NOCASE LIMIT 1"
  ).get(`%${input}%`) as { system_id: number; name: string; sec: number; constellation_id: number } | undefined;
  if (fuzzy) return enrichSystemInfo(db, fuzzy);

  return null;
}

function enrichSystemInfo(db: Db, row: { system_id: number; name: string; sec: number; constellation_id: number }): SystemInfo {
  const constellation = db.prepare('SELECT region_id FROM sde_constellations WHERE constellation_id = ?').get(row.constellation_id) as { region_id: number } | undefined;
  const region = constellation
    ? db.prepare('SELECT name FROM sde_regions WHERE region_id = ?').get(constellation.region_id) as { name: string } | undefined
    : undefined;
  return {
    id: row.system_id,
    name: row.name,
    sec: Math.round(row.sec * 10) / 10,
    region: region?.name ?? 'Unknown',
  };
}

function resolveSystemBatch(db: Db, ids: Set<number>): Map<number, SystemInfo> {
  const map = new Map<number, SystemInfo>();
  if (ids.size === 0) return map;

  const placeholders = [...ids].map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT system_id, name, json_extract(data_json, '$.security') as sec, constellation_id FROM sde_systems WHERE system_id IN (${placeholders})`
  ).all(...ids) as Array<{ system_id: number; name: string; sec: number; constellation_id: number }>;

  for (const row of rows) {
    map.set(row.system_id, enrichSystemInfo(db, row));
  }
  return map;
}

async function fetchRoute(
  db: Db,
  originId: number,
  destId: number,
  flag: RouteFlag,
  avoid: number[],
  chatId: number,
): Promise<number[] | null> {
  const args: Record<string, unknown> = {
    origin: originId,
    destination: destId,
    flag,
  };
  if (avoid.length > 0) {
    args.avoid = avoid;
  }

  const result = await callEsiOperation<number[]>(db, 'get_route_origin_destination', args, chatId);
  if (!result.ok) return null;
  return result.data;
}

function buildRouteVariant(
  flag: RouteFlag,
  systemIds: number[],
  systemInfoMap: Map<number, SystemInfo>,
  killMap: Map<number, SystemKillEntry>,
): RouteVariant {
  let minSec = 1.0;
  let totalShipKills = 0;
  let totalPodKills = 0;
  let totalDanger = 0;
  const hotspots: Hotspot[] = [];
  const systemNames: string[] = [];

  for (const id of systemIds) {
    const info = systemInfoMap.get(id);
    const kills = killMap.get(id);
    const name = info?.name ?? `ID:${id}`;
    const sec = info?.sec ?? 0;

    systemNames.push(name);
    if (sec < minSec) minSec = sec;

    const shipKills = kills?.ship_kills ?? 0;
    const podKills = kills?.pod_kills ?? 0;
    const danger = shipKills * 3 + podKills * 2;

    totalShipKills += shipKills;
    totalPodKills += podKills;
    totalDanger += danger;

    if (shipKills > 0 || podKills > 0) {
      hotspots.push({ name, id, sec, ship_kills: shipKills, pod_kills: podKills, danger_score: danger });
    }
  }

  // Sort hotspots by danger descending, keep top 5
  hotspots.sort((a, b) => b.danger_score - a.danger_score);

  return {
    flag,
    jumps: systemIds.length - 1,
    min_sec: Math.round(minSec * 10) / 10,
    total_ship_kills: totalShipKills,
    total_pod_kills: totalPodKills,
    danger_score: totalDanger,
    hotspots: hotspots.slice(0, 5),
    systems: systemNames,
  };
}

