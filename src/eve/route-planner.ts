import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';
import { getEveCapabilities } from './capabilities.js';
import { getLinkedCharacter } from './sso.js';
import { config } from '../config.js';
import type { UserContext } from '../auth/user-resolver.js';

type RouteFlag = 'secure' | 'shortest' | 'insecure';

type SystemInfo = {
  id: number;
  name: string;
  sec: number;
  region: string;
};



type RecentKill = {
  time: string | null;
  victim: string | null;
  victim_ship: string | null;
  attacker: string | null;
  attacker_ship: string | null;
  value_m: number | null;
  url: string;
};

type DangerSystem = {
  name: string;
  sec: number;
  kills_1h: number;
  pvp: number;
  npc: number;
  total_value_m: number;
  kills: RecentKill[];
};

type RouteVariant = {
  flag: RouteFlag;
  jumps: number;
  min_sec: number;
  safe_count: number;
  total_kills_1h: number;
  total_value_m: number;
  danger_systems: DangerSystem[];
  systems: string[];
};

type AutopilotMode = 'none' | 'exact_route' | 'destination_only';

export type PlanRouteResult = {
  ok: boolean;
  origin: SystemInfo | null;
  destination: SystemInfo | null;
  routes: RouteVariant[];
  autopilot_set: boolean;
  autopilot_mode: AutopilotMode;
  error: string | null;
  formatted_summary: string;
};

export type PlanRouteArgs = {
  origin: string;
  destination: string;
  set_autopilot?: boolean;
  avoid?: number[];
  prefer?: RouteFlag;
};


export async function planRoute(db: Db, args: PlanRouteArgs, ctx: UserContext): Promise<PlanRouteResult> {
  // 1. Resolve origin & destination — "current" uses live location
  const originInfo = await resolveOriginSystem(db, args.origin, ctx);
  const destInfo = resolveSystem(db, args.destination);

  if (!originInfo) {
    return {
      ok: false,
      origin: null,
      destination: null,
      routes: [],
      autopilot_set: false,
      autopilot_mode: 'none',
      error: `Unknown origin system: ${args.origin}`,
      formatted_summary: '',
    };
  }
  if (!destInfo) {
    return {
      ok: false,
      origin: originInfo,
      destination: null,
      routes: [],
      autopilot_set: false,
      autopilot_mode: 'none',
      error: `Unknown destination system: ${args.destination}`,
      formatted_summary: '',
    };
  }

  // 2. Fetch routes (all 3 variants) in parallel
  const flags: RouteFlag[] = ['secure', 'shortest', 'insecure'];
  const routeResults = await Promise.all(
    flags.map((flag) => fetchRoute(db, originInfo.id, destInfo.id, flag, args.avoid ?? [], ctx)),
  );

  // 3. Collect all unique system IDs across all routes
  const allSystemIds = new Set<number>();
  for (const route of routeResults) {
    if (route) for (const id of route) allSystemIds.add(id);
  }

  // 4. Resolve system info from SDE
  const systemInfoMap = resolveSystemBatch(db, allSystemIds);

  // 5. Danger scan: zKill last hour for ALL unique systems
  const dangerMap = await scanSystemDanger(db, allSystemIds, systemInfoMap, ctx);

  // 6. Build route variants with danger data
  const routes: RouteVariant[] = [];
  for (let i = 0; i < flags.length; i++) {
    const systemIds = routeResults[i];
    if (!systemIds || systemIds.length === 0) continue;

    const variant = buildRouteVariant(flags[i], systemIds, systemInfoMap, dangerMap);
    const isDuplicate = routes.some((r) => r.jumps === variant.jumps && r.systems.join(',') === variant.systems.join(','));
    if (!isDuplicate) {
      routes.push(variant);
    }
  }

  // 6. Set autopilot for the preferred route
  let autopilotSet = false;
  let autopilotMode: AutopilotMode = 'none';
  if (args.set_autopilot !== false && routes.length > 0) {
    const preferred = args.prefer
      ? routes.find((r) => r.flag === args.prefer) ?? routes[0]
      : routes.find((r) => r.flag === 'secure') ?? routes[0];

    // Find the system IDs for the preferred route
    const prefIndex = flags.indexOf(preferred.flag);
    const prefSystemIds = routeResults[prefIndex];
    if (prefSystemIds && prefSystemIds.length > 0) {
      const autopilot = await setAutopilotRoute(db, prefSystemIds, destInfo.id, ctx);
      autopilotSet = autopilot.ok;
      autopilotMode = autopilot.mode;
    }
  }

  return {
    ok: true,
    origin: originInfo,
    destination: destInfo,
    routes,
    autopilot_set: autopilotSet,
    autopilot_mode: autopilotMode,
    error: null,
    formatted_summary: formatRouteSummary(originInfo, destInfo, routes, autopilotMode, args.prefer),
  };
}

function formatRouteSummary(
  origin: SystemInfo,
  dest: SystemInfo,
  routes: RouteVariant[],
  autopilotMode: AutopilotMode,
  preferFlag?: RouteFlag,
): string {
  if (routes.length === 0) return 'Маршруты не найдены.';

  const esc = escapeHtml;
  const lines: string[] = [];
  const preferred = (preferFlag && routes.find((route) => route.flag === preferFlag))
    ?? routes.find((route) => route.flag === 'secure')
    ?? routes[0];
  const mergedDangerSystems = mergeDangerSystems(routes);
  const totalKills1h = preferred.total_kills_1h;
  const totalValueM = preferred.total_value_m;
  const preferredDangerSystems = preferred.danger_systems.length;
  const alternatives = routes
    .filter((route) => route.flag !== preferred.flag)
    .map((route) => `${route.flag} ${route.jumps}j min ${route.min_sec.toFixed(1)}`)
    .join(' | ');

  lines.push(`<b>${esc(origin.name)} → ${esc(dest.name)}</b>`);
  lines.push(`Автопилот: ${esc(describeAutopilotMode(autopilotMode))}`);
  lines.push(`Риск: ${describeRouteRisk(preferred, preferredDangerSystems)}, опасных систем: ${preferredDangerSystems}, киллов за 1ч: ${totalKills1h}, потери: ${totalValueM}M ISK`);

  lines.push('');
  lines.push('<code>route     jumps min  kills isk');
  for (const route of routes) {
    lines.push(formatVariantRow(route));
  }
  lines.push('</code>');

  lines.push('');
  lines.push(`<b>Основной маршрут</b> (${esc(preferred.flag)}): ${formatSystemChain(preferred.systems)}`);
  if (alternatives) {
    lines.push(`Альтернативы: ${esc(alternatives)}`);
  }

  if (mergedDangerSystems.length > 0) {
    lines.push('');
    lines.push('<b>Опасные системы по всем вариантам</b>');
    for (const ds of mergedDangerSystems) {
      lines.push(
        `<b>${esc(ds.name)}</b> ${ds.sec.toFixed(1)} | маршруты: ${esc(formatRouteFlags(ds.route_flags))} | ` +
        `${ds.kills_1h} kills | PvP ${ds.pvp} | ${ds.total_value_m}M ISK`,
      );
      for (const preview of formatDangerPreview(ds)) {
        lines.push(preview);
      }
      if (ds.kills.length < ds.kills_1h) {
        lines.push(`  Показаны детальные данные для ${ds.kills.length} из ${ds.kills_1h} киллов.`);
      }
    }
  }

  return lines.join('\n').trim();
}

function formatVariantRow(route: RouteVariant): string {
  const cols = [
    route.flag.padEnd(9, ' '),
    String(route.jumps).padEnd(5, ' '),
    route.min_sec.toFixed(1).padEnd(4, ' '),
    String(route.total_kills_1h).padEnd(5, ' '),
    `${route.total_value_m}M`,
  ];
  return cols.join(' ');
}

function describeRouteRisk(route: RouteVariant, dangerSystems: number): string {
  if (route.min_sec < 0.5 || route.total_kills_1h >= 10) return 'высокий';
  if (route.min_sec < 0.8 || dangerSystems > 0 || route.total_kills_1h > 0) return 'средний';
  return 'низкий';
}

function formatSystemChain(systems: string[]): string {
  return systems.map((name) => `<b>${escapeHtml(name)}</b>`).join(' → ');
}

function formatRouteFlags(flags: RouteFlag[]): string {
  return flags.join(', ');
}

function formatDangerPreview(ds: DangerSystem): string[] {
  return ds.kills.map((kill) => {
    const time = escapeHtml(kill.time ?? '?');
    const victim = escapeHtml(kill.victim ?? '?');
    const attacker = escapeHtml(kill.attacker ?? '?');
    const ship = escapeHtml(kill.victim_ship ?? '?');
    const isk = kill.value_m ? ` | ${kill.value_m}M` : '';
    const link = kill.url ? ` | <a href="${escapeHtmlAttribute(kill.url)}">zKill</a>` : '';
    return `  ${time} ${victim} -> ${attacker} | ${ship}${isk}${link}`;
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

async function resolveOriginSystem(db: Db, origin: string, ctx: UserContext): Promise<SystemInfo | null> {
  if (origin.toLowerCase() !== 'current') {
    return resolveSystem(db, origin);
  }

  const cachedSystemId = resolveCurrentSystemFromCache(db, ctx);
  if (cachedSystemId) {
    return resolveSystem(db, cachedSystemId);
  }

  const linked = getLinkedCharacter(db, ctx);
  if (!linked) return null;

  const liveLocation = await callEsiOperation<{ solar_system_id?: number }>(
    db,
    'get_characters_character_id_location',
    { character_id: linked.characterId },
    ctx,
  );
  if (!liveLocation.ok || !liveLocation.data?.solar_system_id) return null;
  return resolveSystem(db, String(liveLocation.data.solar_system_id));
}

function resolveCurrentSystemFromCache(db: Db, ctx: UserContext): string | null {
  const linked = getLinkedCharacter(db, ctx);
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

const SYSTEM_SECURITY_SQL = "coalesce(json_extract(data_json, '$.securityStatus'), json_extract(data_json, '$.security'))";

function resolveSystem(db: Db, input: string): SystemInfo | null {
  // Try as system_id first
  const asId = Number(input);
  if (Number.isFinite(asId) && asId > 0) {
    const row = db.prepare(
      `SELECT system_id, name, ${SYSTEM_SECURITY_SQL} as sec, constellation_id
       FROM sde_systems
       WHERE system_id = ?`
    ).get(asId) as { system_id: number; name: string; sec: number; constellation_id: number } | undefined;
    if (row) return enrichSystemInfo(db, row);
  }

  // Try exact name match
  const byName = db.prepare(
    `SELECT system_id, name, ${SYSTEM_SECURITY_SQL} as sec, constellation_id
     FROM sde_systems
     WHERE name = ? COLLATE NOCASE`
  ).get(input) as { system_id: number; name: string; sec: number; constellation_id: number } | undefined;
  if (byName) return enrichSystemInfo(db, byName);

  // Try fuzzy
  const fuzzy = db.prepare(
    `SELECT system_id, name, ${SYSTEM_SECURITY_SQL} as sec, constellation_id
     FROM sde_systems
     WHERE name LIKE ? COLLATE NOCASE
     LIMIT 1`
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
    sec: normalizeSecurity(row.sec),
    region: region?.name ?? 'Unknown',
  };
}

function resolveSystemBatch(db: Db, ids: Set<number>): Map<number, SystemInfo> {
  const map = new Map<number, SystemInfo>();
  if (ids.size === 0) return map;

  const placeholders = [...ids].map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT system_id, name, ${SYSTEM_SECURITY_SQL} as sec, constellation_id
     FROM sde_systems
     WHERE system_id IN (${placeholders})`
  ).all(...ids) as Array<{ system_id: number; name: string; sec: number; constellation_id: number }>;

  for (const row of rows) {
    map.set(row.system_id, enrichSystemInfo(db, row));
  }
  return map;
}

function normalizeSecurity(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

async function fetchRoute(
  db: Db,
  originId: number,
  destId: number,
  flag: RouteFlag,
  avoid: number[],
  ctx: UserContext,
): Promise<number[] | null> {
  const args: Record<string, unknown> = {
    origin: originId,
    destination: destId,
    flag,
  };
  if (avoid.length > 0) {
    args.avoid = avoid;
  }

  const result = await callEsiOperation<number[]>(db, 'get_route_origin_destination', args, ctx);
  if (!result.ok) return null;
  return result.data;
}

async function setAutopilotRoute(
  db: Db,
  systemIds: number[],
  destinationId: number,
  ctx: UserContext,
): Promise<{ ok: boolean; mode: AutopilotMode }> {
  const waypoints = systemIds.slice(1);
  if (waypoints.length === 0) {
    return { ok: false, mode: 'none' };
  }

  await getEveCapabilities(db, 'route_autopilot', ctx);

  try {
    for (let index = 0; index < waypoints.length; index += 1) {
      const result = await callEsiOperation(db, 'post_ui_autopilot_waypoint', {
        destination_id: waypoints[index],
        clear_other_waypoints: index === 0,
        add_to_beginning: false,
      }, ctx);
      if (!result.ok) {
        throw new Error(result.error);
      }
    }
    return { ok: true, mode: 'exact_route' };
  } catch (err) {
    console.log('[plan_route] exact autopilot ESI failed: %s', err instanceof Error ? err.message : String(err));
  }

  const fallback = await callEsiOperation(db, 'post_ui_autopilot_waypoint', {
    destination_id: destinationId,
    clear_other_waypoints: true,
    add_to_beginning: false,
  }, ctx);
  if (fallback.ok) {
    return { ok: true, mode: 'destination_only' };
  }

  console.log('[plan_route] destination autopilot ESI failed: %s', fallback.error);
  return { ok: false, mode: 'none' };
}

function buildRouteVariant(
  flag: RouteFlag,
  systemIds: number[],
  systemInfoMap: Map<number, SystemInfo>,
  dangerMap: Map<number, DangerSystem>,
): RouteVariant {
  let minSec = 1.0;
  const systemNames: string[] = [];
  const dangerSystems: DangerSystem[] = [];
  let totalKills = 0;
  let totalValue = 0;

  for (const id of systemIds) {
    const info = systemInfoMap.get(id);
    const name = info?.name ?? `ID:${id}`;
    const sec = info?.sec ?? 0;
    systemNames.push(name);
    if (sec < minSec) minSec = sec;

    const danger = dangerMap.get(id);
    if (danger && danger.kills_1h > 0) {
      dangerSystems.push(danger);
      totalKills += danger.kills_1h;
      totalValue += danger.total_value_m;
    }
  }

  dangerSystems.sort((a, b) => b.kills_1h - a.kills_1h);

  return {
    flag,
    jumps: systemIds.length - 1,
    min_sec: Math.round(minSec * 10) / 10,
    safe_count: systemIds.length - dangerSystems.length,
    total_kills_1h: totalKills,
    total_value_m: totalValue,
    danger_systems: dangerSystems,
    systems: systemNames,
  };
}

// ---------------------------------------------------------------------------
// Danger scan: zKill last hour + ESI enrichment for ALL systems on route
// ---------------------------------------------------------------------------

type ZkillFeedItem = {
  killmail_id: number;
  zkb?: {
    hash?: string;
    totalValue?: number;
    npc?: boolean;
    solo?: boolean;
  };
};

const MAX_KILLS_PER_SYSTEM = 5;
const DANGER_SCAN_CONCURRENCY = 10;
const DANGER_SCAN_PAST_SECONDS = 3600;

async function scanSystemDanger(
  db: Db,
  systemIds: Set<number>,
  systemInfoMap: Map<number, SystemInfo>,
  _ctx: UserContext,
): Promise<Map<number, DangerSystem>> {
  const ids = [...systemIds];
  console.log('[danger_scan] scanning %d systems (pastSeconds=%d, max %d kills each)',
    ids.length, DANGER_SCAN_PAST_SECONDS, MAX_KILLS_PER_SYSTEM);

  // Step 1: Parallel zKill requests for all systems
  const feedMap = new Map<number, ZkillFeedItem[]>();
  await mapWithConcurrency(ids, DANGER_SCAN_CONCURRENCY, async (systemId) => {
    const feed = await fetchZkillFeed(systemId);
    if (feed.length > 0) feedMap.set(systemId, feed);
  });

  const systemsWithKills = feedMap.size;
  const totalFeedItems = [...feedMap.values()].reduce((s, f) => s + f.length, 0);
  console.log('[danger_scan] zKill done: %d/%d systems have kills, %d total feed items',
    systemsWithKills, ids.length, totalFeedItems);

  if (feedMap.size === 0) return new Map();

  // Step 2: Collect all killmails that need ESI enrichment (top N per system)
  const enrichList: Array<{ systemId: number; item: ZkillFeedItem }> = [];
  for (const [systemId, feed] of feedMap) {
    const toEnrich = feed.slice(0, MAX_KILLS_PER_SYSTEM).filter((item) => item.zkb?.hash);
    for (const item of toEnrich) {
      enrichList.push({ systemId, item });
    }
  }

  // Step 3: Parallel ESI killmail enrichment
  type RawKill = {
    systemId: number;
    killmailId: number;
    time: string | null;
    victimCharId: number | null;
    victimCorpId: number | null;
    victimShipTypeId: number | null;
    attackerCharId: number | null;
    attackerCorpId: number | null;
    attackerShipTypeId: number | null;
    valueM: number;
    npc: boolean;
  };

  const rawKills: RawKill[] = [];
  await mapWithConcurrency(enrichList, DANGER_SCAN_CONCURRENCY, async ({ systemId, item }) => {
    const raw = await fetchKillmailForDanger(db, systemId, item);
    if (raw) rawKills.push(raw);
  });

  console.log('[danger_scan] ESI enriched %d/%d killmails', rawKills.length, enrichList.length);

  // Step 4: Batch resolve character/corp names
  const idsToResolve = new Set<number>();
  for (const raw of rawKills) {
    for (const id of [raw.victimCharId, raw.victimCorpId, raw.attackerCharId, raw.attackerCorpId]) {
      if (id !== null) idsToResolve.add(id);
    }
  }
  const nameMap = await resolveNamesBatch(db, idsToResolve);

  // Step 5: Build DangerSystem entries
  const dangerMap = new Map<number, DangerSystem>();
  for (const [systemId, feed] of feedMap) {
    const info = systemInfoMap.get(systemId);
    const systemKills = rawKills.filter((k) => k.systemId === systemId);
    const npcCount = feed.filter((item) => item.zkb?.npc).length;
    const pvpCount = feed.length - npcCount;
    const totalValueM = feed.reduce((s, item) => s + Math.round((item.zkb?.totalValue ?? 0) / 1_000_000), 0);

    const kills: RecentKill[] = systemKills.map((raw) => ({
      time: raw.time ? toMSK(raw.time) : null,
      victim: nameMap.get(raw.victimCharId ?? 0) ?? nameMap.get(raw.victimCorpId ?? 0) ?? null,
      victim_ship: resolveTypeName(db, raw.victimShipTypeId),
      attacker: nameMap.get(raw.attackerCharId ?? 0) ?? nameMap.get(raw.attackerCorpId ?? 0) ?? null,
      attacker_ship: resolveTypeName(db, raw.attackerShipTypeId),
      value_m: raw.valueM,
      url: `https://zkillboard.com/kill/${raw.killmailId}/`,
    }));

    dangerMap.set(systemId, {
      name: info?.name ?? `ID:${systemId}`,
      sec: info?.sec ?? 0,
      kills_1h: feed.length,
      pvp: pvpCount,
      npc: npcCount,
      total_value_m: totalValueM,
      kills,
    });
  }

  console.log('[danger_scan] result: %d danger systems, %d enriched kills, %d names resolved',
    dangerMap.size, rawKills.length, nameMap.size);

  return dangerMap;
}

const zkillFeedCache = new Map<number, { data: ZkillFeedItem[]; fetchedAt: number }>();
const ZKILL_FEED_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchZkillFeed(systemId: number): Promise<ZkillFeedItem[]> {
  const now = Date.now();
  const cached = zkillFeedCache.get(systemId);
  if (cached && now - cached.fetchedAt < ZKILL_FEED_CACHE_TTL_MS) {
    return cached.data;
  }

  const baseUrl = config.zkill.baseUrl.endsWith('/') ? config.zkill.baseUrl : `${config.zkill.baseUrl}/`;
  const url = `${baseUrl}kills/systemID/${systemId}/pastSeconds/${DANGER_SCAN_PAST_SECONDS}/`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': config.zkill.userAgent,
      },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const feed = data.filter((item: unknown): item is ZkillFeedItem =>
      !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).killmail_id === 'number',
    );
    zkillFeedCache.set(systemId, { data: feed, fetchedAt: now });
    return feed;
  } catch {
    return [];
  }
}

async function fetchKillmailForDanger(
  db: Db, systemId: number, item: ZkillFeedItem,
): Promise<{
  systemId: number; killmailId: number; time: string | null;
  victimCharId: number | null; victimCorpId: number | null; victimShipTypeId: number | null;
  attackerCharId: number | null; attackerCorpId: number | null; attackerShipTypeId: number | null;
  valueM: number; npc: boolean;
} | null> {
  const hash = item.zkb?.hash;
  if (!hash) return null;
  try {
    const result = await callEsiOperation<Record<string, unknown>>(
      db, 'get_killmails_killmail_id_killmail_hash',
      { killmail_id: item.killmail_id, killmail_hash: hash },
    );
    if (!result.ok || !result.data) return null;
    const km = result.data;
    const victim = (km.victim && typeof km.victim === 'object') ? km.victim as Record<string, unknown> : {};
    const attackers = Array.isArray(km.attackers) ? km.attackers as Record<string, unknown>[] : [];
    const finalBlow = attackers.find((a) => a.final_blow === true) ?? attackers[0] ?? {};
    return {
      systemId,
      killmailId: item.killmail_id,
      time: typeof km.killmail_time === 'string' ? km.killmail_time : null,
      victimCharId: numOrNull(victim.character_id),
      victimCorpId: numOrNull(victim.corporation_id),
      victimShipTypeId: numOrNull(victim.ship_type_id),
      attackerCharId: numOrNull(finalBlow.character_id),
      attackerCorpId: numOrNull(finalBlow.corporation_id),
      attackerShipTypeId: numOrNull(finalBlow.ship_type_id),
      valueM: Math.round((item.zkb?.totalValue ?? 0) / 1_000_000),
      npc: item.zkb?.npc ?? false,
    };
  } catch {
    return null;
  }
}

async function resolveNamesBatch(db: Db, ids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.size === 0) return map;
  const idArray = [...ids].slice(0, 500);
  try {
    const result = await callEsiOperation<Array<{ id: number; name: string }>>(
      db, 'post_universe_names', { ids: JSON.stringify(idArray) },
    );
    if (result.ok && Array.isArray(result.data)) {
      for (const entry of result.data) {
        if (entry.id && entry.name) map.set(entry.id, entry.name);
      }
    }
  } catch { /* no names */ }
  return map;
}

function toMSK(utcTime: string): string {
  try {
    const d = new Date(utcTime);
    return d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) + ' MSK';
  } catch {
    return utcTime;
  }
}

const typeNameCache = new Map<number, string | null>();

function resolveTypeName(db: Db, typeId: number | null): string | null {
  if (typeId === null) return null;
  if (typeNameCache.has(typeId)) return typeNameCache.get(typeId)!;
  const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  const name = row?.name ?? null;
  typeNameCache.set(typeId, name);
  return name;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function describeAutopilotMode(mode: AutopilotMode): string {
  if (mode === 'exact_route') return 'выставлен';
  if (mode === 'destination_only') return 'точка назначения выставлена';
  return 'нет';
}

function mergeDangerSystems(routes: RouteVariant[]): Array<DangerSystem & { route_flags: RouteFlag[] }> {
  const merged = new Map<string, DangerSystem & { route_flags: RouteFlag[] }>();

  for (const route of routes) {
    for (const danger of route.danger_systems) {
      const existing = merged.get(danger.name);
      if (existing) {
        if (!existing.route_flags.includes(route.flag)) {
          existing.route_flags.push(route.flag);
        }
        continue;
      }
      merged.set(danger.name, {
        ...danger,
        route_flags: [route.flag],
      });
    }
  }

  return [...merged.values()].sort((left, right) => (
    right.kills_1h - left.kills_1h
    || left.sec - right.sec
    || left.name.localeCompare(right.name)
  ));
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}
