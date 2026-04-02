import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';
import { getEveCapabilities } from './capabilities.js';
import { getLinkedCharacter } from './sso.js';
import { config } from '../config.js';
import type { UserContext } from '../auth/user-resolver.js';
import { startRouteMonitor } from '../eve-board/monitor.js';
import { generateBriefing } from '../eve-board/briefing.js';

type RouteFlag = 'secure' | 'shortest' | 'insecure';

// ---------------------------------------------------------------------------
// Route monitor sender — set once from app.ts at boot time
// ---------------------------------------------------------------------------

let routeMonitorSender: ((chatId: number, text: string) => void) | null = null;

export function setRouteMonitorSender(sender: (chatId: number, text: string) => void): void {
  routeMonitorSender = sender;
}

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

  // 5. Danger scan: EVE-KILL last hour for ALL unique systems
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

  let formattedSummary = formatRouteSummary(originInfo, destInfo, routes, autopilotMode, args.prefer);

  const linked = getLinkedCharacter(db, ctx);
  const characterId = linked?.characterId ?? 0;
  const chatId = ctx.chatId ?? ctx.userId;

  // Get the preferred route's system IDs for the selected route
  const preferredRoute = args.prefer
    ? routes.find((r) => r.flag === args.prefer) ?? routes[0]
    : routes.find((r) => r.flag === 'secure') ?? routes[0];
  const prefIndex = flags.indexOf(preferredRoute.flag);
  const monitorSystemIds = routeResults[prefIndex] ?? [];

  if (characterId > 0 && monitorSystemIds.length > 0) {
    // Fetch current ship info for threat assessment
    let shipTypeId = 0;
    let shipName = 'Unknown';
    try {
      const shipInfo = await callEsiOperation<{ ship_type_id?: number; ship_name?: string }>(
        db,
        'get_characters_character_id_ship',
        { character_id: characterId },
        ctx,
      );
      if (shipInfo.ok && shipInfo.data) {
        shipTypeId = shipInfo.data.ship_type_id ?? 0;
        shipName = shipInfo.data.ship_name ?? 'Unknown';
      }
    } catch (err) {
      console.log('[plan_route] ship fetch failed: %s', err instanceof Error ? err.message : String(err));
    }

    // Generate pre-flight briefing and append to summary
    try {
      const briefing = await generateBriefing(
        db, monitorSystemIds, originInfo.name, destInfo.name, characterId, shipTypeId,
      );
      if (briefing) {
        formattedSummary += '\n\n' + briefing;
      }
    } catch (err) {
      console.log('[plan_route] briefing generation failed: %s', err instanceof Error ? err.message : String(err));
    }

    // Auto-start route monitor only when autopilot is actually active
    if (autopilotSet && routeMonitorSender) {
      startRouteMonitor(db, chatId, characterId, monitorSystemIds, shipTypeId, shipName, routeMonitorSender);
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
    formatted_summary: formattedSummary,
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
  const dangerCount = preferred.danger_systems.length;
  const alternativeHint = describeAlternativeHint(routes, preferred);

  // Header
  lines.push(`<b>${esc(origin.name)} → ${esc(dest.name)}</b>`);
  const riskEmoji = describeRouteRiskEmoji(preferred, dangerCount);
  lines.push(`${riskEmoji} Выбран: ${esc(preferred.flag)} | ${preferred.jumps} прыжков | мин. сек: ${preferred.min_sec.toFixed(1)} | киллов/ч: ${preferred.total_kills_1h} | потери: ${preferred.total_value_m}M`);
  lines.push(`Автопилот: ${esc(describeAutopilotMode(autopilotMode))} (${esc(preferred.flag)})`);
  if (alternativeHint) {
    lines.push(alternativeHint);
  }

  // Route comparison table — keep compact as a secondary layer.
  if (routes.length > 1) {
    lines.push('');
    lines.push('<code>');
    lines.push('         прыж  сек   kills');
    for (const route of routes) {
      const marker = route.flag === preferred.flag ? '>' : ' ';
      lines.push(`${marker}${formatVariantRow(route)}`);
    }
    lines.push('</code>');
  }

  lines.push('');
  lines.push(`Ключевые точки: <code>${esc(buildRoutePreview(preferred))}</code>`);

  const zkbLines = buildSelectedRouteKillSummary(preferred);
  if (zkbLines.length > 0) {
    lines.push('');
    lines.push(...zkbLines);
  }

  return lines.join('\n').trim();
}

function formatVariantRow(route: RouteVariant): string {
  return [
    route.flag.padEnd(8),
    String(route.jumps).padStart(3),
    `  ${route.min_sec.toFixed(1)}`,
    `  ${String(route.total_kills_1h).padStart(4)}`,
  ].join('');
}

function describeRouteRiskEmoji(route: RouteVariant, dangerSystems: number): string {
  if (route.min_sec < 0.5 || route.total_kills_1h >= 10) return '\u{1F534}'; // red circle
  if (route.min_sec < 0.8 || dangerSystems > 0 || route.total_kills_1h > 0) return '\u{1F7E1}'; // yellow circle
  return '\u{1F7E2}'; // green circle
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

function describeAlternativeHint(routes: RouteVariant[], preferred: RouteVariant): string | null {
  const candidates = routes.filter((route) => route.flag !== preferred.flag);
  if (candidates.length === 0) return null;

  const safer = candidates
    .filter((route) => route.total_kills_1h < preferred.total_kills_1h || route.min_sec > preferred.min_sec)
    .sort((left, right) => {
      if (left.total_kills_1h !== right.total_kills_1h) return left.total_kills_1h - right.total_kills_1h;
      return right.min_sec - left.min_sec;
    })[0];

  if (safer && safer.total_kills_1h + 3 < preferred.total_kills_1h) {
    return `Альтернатива: ${safer.flag} тише по киллам (${safer.total_kills_1h} против ${preferred.total_kills_1h}), но смотрите на jumps/sec.`;
  }

  const faster = candidates
    .filter((route) => route.jumps < preferred.jumps)
    .sort((left, right) => left.jumps - right.jumps)[0];

  if (faster && faster.jumps + 2 <= preferred.jumps) {
    return `Альтернатива: ${faster.flag} короче на ${preferred.jumps - faster.jumps} прыжков, но риск выше.`;
  }

  return null;
}

function buildRoutePreview(route: RouteVariant): string {
  if (route.systems.length <= 6) return route.systems.join(' → ');

  const preview: string[] = [];
  const add = (name: string | undefined): void => {
    if (!name) return;
    if (preview.includes(name)) return;
    preview.push(name);
  };

  add(route.systems[0]);
  add(route.systems[1]);

  const dangerNames = route.systems.filter((name) =>
    route.danger_systems.some((danger) => danger.name === name),
  );
  for (const name of dangerNames.slice(0, 2)) add(name);

  add(route.systems[route.systems.length - 2]);
  add(route.systems[route.systems.length - 1]);

  return preview.join(' → ');
}

function buildSelectedRouteKillSummary(route: RouteVariant): string[] {
  if (route.danger_systems.length === 0) {
    return ['zKB срез: на выбранной трассе свежих killmail за последний час не видно.'];
  }

  const lines = ['zKB срез:'];
  for (const system of route.danger_systems.slice(0, 2)) {
    lines.push(`- ${escapeHtml(system.name)} ${system.sec.toFixed(1)}: ${system.kills_1h} PvP, ${system.total_value_m}M`);
    for (const kill of system.kills.slice(0, 2)) {
      const victimShip = escapeHtml(kill.victim_ship ?? '?');
      const victim = escapeHtml(kill.victim ?? '?');
      const attacker = escapeHtml(kill.attacker ?? '?');
      const value = kill.value_m && kill.value_m > 0 ? ` ${kill.value_m}M` : '';
      const time = kill.time ?? 'недавно';
      const link = kill.url ? ` <a href="${escapeHtmlAttribute(kill.url)}">zkb</a>` : '';
      lines.push(`  ${time} ${victimShip}${value} ${victim} <- ${attacker}${link}`);
    }
  }
  return lines;
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
// Danger scan: zKillboard + ESI enrichment (EVE-KILL killlist ignores system_id)
// ---------------------------------------------------------------------------

const MAX_KILLS_PER_SYSTEM = 3;
const DANGER_SCAN_CONCURRENCY = 10;
const DANGER_SCAN_PAST_SECONDS = 3600;
const DANGER_SCAN_WINDOW_MINUTES = DANGER_SCAN_PAST_SECONDS / 60;

type ZkillFeedItem = {
  killmail_id: number;
  zkb?: { hash?: string; totalValue?: number; npc?: boolean; solo?: boolean };
};

async function scanSystemDanger(
  db: Db,
  systemIds: Set<number>,
  systemInfoMap: Map<number, SystemInfo>,
  _ctx: UserContext,
): Promise<Map<number, DangerSystem>> {
  const ids = [...systemIds];
  if (ids.length === 0) return new Map();

  console.log('[danger_scan] scanning %d systems via zKillboard', ids.length);

  // Step 1: Parallel zKB fetches
  const feedMap = new Map<number, ZkillFeedItem[]>();
  let idx = 0;
  const fetchNext = async (): Promise<void> => {
    while (idx < ids.length) {
      const systemId = ids[idx++];
      const feed = await fetchZkbFeed(systemId);
      if (feed.length > 0) feedMap.set(systemId, feed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DANGER_SCAN_CONCURRENCY, ids.length) }, () => fetchNext()));

  if (feedMap.size === 0) {
    console.log('[danger_scan] no kills found');
    return new Map();
  }

  // Step 2: Enrich top kills per system via ESI
  type EnrichItem = { systemId: number; item: ZkillFeedItem };
  const enrichList: EnrichItem[] = [];
  for (const [systemId, feed] of feedMap) {
    for (const item of feed.slice(0, MAX_KILLS_PER_SYSTEM).filter((i) => i.zkb?.hash)) {
      enrichList.push({ systemId, item });
    }
  }

  type RawKill = {
    systemId: number; killmailId: number; time: string | null;
    victimCharId: number | null; victimCorpId: number | null; victimShipTypeId: number | null;
    attackerCharId: number | null; attackerCorpId: number | null; attackerShipTypeId: number | null;
    valueM: number;
    isNpc: boolean;
  };
  const rawKills: RawKill[] = [];
  let eidx = 0;
  const enrichNext = async (): Promise<void> => {
    while (eidx < enrichList.length) {
      const { systemId, item } = enrichList[eidx++];
      const hash = item.zkb?.hash;
      if (!hash) continue;
      try {
        const r = await callEsiOperation<Record<string, unknown>>(db, 'get_killmails_killmail_id_killmail_hash', { killmail_id: item.killmail_id, killmail_hash: hash });
        if (!r.ok || !r.data) continue;
        const km = r.data;
        const victim = asRec(km.victim);
        const attackers = Array.isArray(km.attackers) ? km.attackers as Record<string, unknown>[] : [];
        const fb = attackers.find((a) => a.final_blow === true) ?? attackers[0] ?? {};
        rawKills.push({
          systemId, killmailId: item.killmail_id,
          time: typeof km.killmail_time === 'string' ? km.killmail_time : null,
          victimCharId: numOrNull(victim.character_id), victimCorpId: numOrNull(victim.corporation_id),
          victimShipTypeId: numOrNull(victim.ship_type_id),
          attackerCharId: numOrNull(fb.character_id), attackerCorpId: numOrNull(fb.corporation_id),
          attackerShipTypeId: numOrNull(fb.ship_type_id),
          valueM: Math.round((item.zkb?.totalValue ?? 0) / 1_000_000),
          isNpc: item.zkb?.npc === true,
        });
      } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DANGER_SCAN_CONCURRENCY, enrichList.length) }, () => enrichNext()));

  // Step 3: Batch resolve names
  const idsToResolve = new Set<number>();
  for (const rk of rawKills) {
    for (const id of [rk.victimCharId, rk.victimCorpId, rk.attackerCharId, rk.attackerCorpId]) {
      if (id) idsToResolve.add(id);
    }
  }
  const nameMap = await resolveNamesBatch(db, idsToResolve);

  // Step 4: Build DangerSystem entries
  const dangerMap = new Map<number, DangerSystem>();
  for (const [systemId] of feedMap) {
    const info = systemInfoMap.get(systemId);
    const systemKills = rawKills
      .filter((rk) => rk.systemId === systemId && isKillInsideDangerWindow(rk.time));
    if (systemKills.length === 0) continue;

    const npcCount = systemKills.filter((rk) => rk.isNpc).length;
    const pvpCount = systemKills.length - npcCount;
    const totalValueM = systemKills.reduce((sum, rk) => sum + rk.valueM, 0);
    const kills: RecentKill[] = systemKills.map((rk) => ({
      time: rk.time ? toMSK(rk.time) : null,
      victim: nameMap.get(rk.victimCharId ?? 0) ?? nameMap.get(rk.victimCorpId ?? 0) ?? null,
      victim_ship: resolveTypeName(db, rk.victimShipTypeId),
      attacker: nameMap.get(rk.attackerCharId ?? 0) ?? nameMap.get(rk.attackerCorpId ?? 0) ?? null,
      attacker_ship: resolveTypeName(db, rk.attackerShipTypeId),
      value_m: rk.valueM,
      url: `https://zkillboard.com/kill/${rk.killmailId}/`,
    }));

    dangerMap.set(systemId, {
      name: info?.name ?? `ID:${systemId}`,
      sec: info?.sec ?? 0,
      kills_1h: systemKills.length,
      pvp: pvpCount,
      npc: npcCount,
      total_value_m: totalValueM,
      kills,
    });
  }

  console.log('[danger_scan] result: %d danger systems', dangerMap.size);
  return dangerMap;
}

// zKB helpers
async function fetchZkbFeed(systemId: number): Promise<ZkillFeedItem[]> {
  const url = `${config.zkill.baseUrl}kills/systemID/${systemId}/pastSeconds/${DANGER_SCAN_PAST_SECONDS}/`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': config.zkill.userAgent },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((item: unknown): item is ZkillFeedItem =>
      !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).killmail_id === 'number',
    );
  } catch { return []; }
}

async function resolveNamesBatch(db: Db, ids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.size === 0) return map;
  try {
    const r = await callEsiOperation<Array<{ id: number; name: string }>>(db, 'post_universe_names', { ids: JSON.stringify([...ids].slice(0, 100)) });
    if (r.ok && Array.isArray(r.data)) {
      for (const e of r.data) { if (e.id && e.name) map.set(e.id, e.name); }
    }
  } catch { /* */ }
  return map;
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

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toMSK(utcTime: string): string {
  try {
    const d = new Date(utcTime);
    return d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) + ' MSK';
  } catch {
    return utcTime;
  }
}

function isKillInsideDangerWindow(value: string | null): boolean {
  const minutes = value ? minutesSinceIso(value) : null;
  return minutes === null || minutes <= DANGER_SCAN_WINDOW_MINUTES;
}

function minutesSinceIso(value: string): number | null {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60_000));
}

function describeAutopilotMode(mode: AutopilotMode): string {
  if (mode === 'exact_route') return 'выставлен';
  if (mode === 'destination_only') return 'точка назначения выставлена';
  return 'нет';
}
