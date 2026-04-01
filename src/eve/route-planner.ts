import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';
import { getEveCapabilities } from './capabilities.js';
import { getLinkedCharacter } from './sso.js';
import { getKilllist } from '../eve-kill/client.js';
import type { KilllistItem } from '../eve-kill/client.js';
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

  // Auto-start route monitor and generate briefing when autopilot is set
  if (autopilotSet && routeMonitorSender) {
    const linked = getLinkedCharacter(db, ctx);
    const characterId = linked?.characterId ?? 0;
    const chatId = ctx.chatId ?? ctx.userId;

    // Get the preferred route's system IDs for the monitor
    const preferred = args.prefer
      ? routes.find((r) => r.flag === args.prefer) ?? routes[0]
      : routes.find((r) => r.flag === 'secure') ?? routes[0];
    const prefIndex = flags.indexOf(preferred.flag);
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

      // Start the route monitor
      startRouteMonitor(db, chatId, characterId, monitorSystemIds, shipTypeId, shipName, routeMonitorSender);

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
  const mergedDangerSystems = mergeDangerSystems(routes);
  const dangerCount = preferred.danger_systems.length;

  // Header
  lines.push(`<b>${esc(origin.name)} → ${esc(dest.name)}</b>`);
  const riskEmoji = describeRouteRiskEmoji(preferred, dangerCount);
  lines.push(`${riskEmoji} ${preferred.jumps} прыжков | мин. сек: ${preferred.min_sec.toFixed(1)} | киллов/ч: ${preferred.total_kills_1h} | потери: ${preferred.total_value_m}M`);
  lines.push(`Автопилот: ${esc(describeAutopilotMode(autopilotMode))} (${esc(preferred.flag)})`);

  // Route comparison table
  if (routes.length > 1) {
    lines.push('');
    lines.push('<code>');
    lines.push('         прыж  сек   kills  ISK');
    for (const route of routes) {
      const marker = route.flag === preferred.flag ? '>' : ' ';
      lines.push(`${marker}${formatVariantRow(route)}`);
    }
    lines.push('</code>');
  }

  // System chain — compact, no bold per system
  lines.push('');
  const chain = preferred.systems.join(' → ');
  if (chain.length > 120) {
    // Long chain: split into lines of ~60 chars
    const parts: string[] = [];
    let current = '';
    for (const sys of preferred.systems) {
      const next = current ? `${current} → ${sys}` : sys;
      if (next.length > 60 && current) {
        parts.push(current + ' →');
        current = sys;
      } else {
        current = next;
      }
    }
    if (current) parts.push(current);
    lines.push(`<code>${parts.join('\n')}</code>`);
  } else {
    lines.push(`<code>${esc(chain)}</code>`);
  }

  // Danger report
  if (mergedDangerSystems.length > 0) {
    lines.push('');
    lines.push('<b>Опасные системы</b>');
    for (const ds of mergedDangerSystems) {
      const secLabel = ds.sec < 0.5 ? 'low' : 'hi';
      const routeLabel = ds.route_flags.length < routes.length
        ? ` [${ds.route_flags.join(', ')}]`
        : '';
      lines.push(`\n<b>${esc(ds.name)}</b> ${ds.sec.toFixed(1)} ${secLabel}${routeLabel} — ${ds.kills_1h} kills, ${ds.total_value_m}M ISK`);

      for (const kill of ds.kills) {
        const time = kill.time?.split(' ')[0] ?? '?'; // just HH:MM
        const ship = esc(kill.victim_ship ?? '?');
        const isk = kill.value_m ? ` ${kill.value_m}M` : '';
        const link = kill.url ? `<a href="${escapeHtmlAttribute(kill.url)}">kill</a>` : '';
        const victim = esc(truncateName(kill.victim));
        lines.push(`  ${time} ${ship}${isk} ${victim} ${link}`);
      }
      if (ds.kills.length < ds.kills_1h) {
        lines.push(`  <i>+${ds.kills_1h - ds.kills.length} ещё</i>`);
      }
    }
  } else {
    lines.push('');
    lines.push('Опасных систем не обнаружено.');
  }

  return lines.join('\n').trim();
}

function formatVariantRow(route: RouteVariant): string {
  return [
    route.flag.padEnd(8),
    String(route.jumps).padStart(3),
    `  ${route.min_sec.toFixed(1)}`,
    `  ${String(route.total_kills_1h).padStart(4)}`,
    `  ${route.total_value_m}M`,
  ].join('');
}

function describeRouteRiskEmoji(route: RouteVariant, dangerSystems: number): string {
  if (route.min_sec < 0.5 || route.total_kills_1h >= 10) return '\u{1F534}'; // red circle
  if (route.min_sec < 0.8 || dangerSystems > 0 || route.total_kills_1h > 0) return '\u{1F7E1}'; // yellow circle
  return '\u{1F7E2}'; // green circle
}

function truncateName(name: string | null): string {
  if (!name) return '?';
  return name.length > 16 ? name.slice(0, 14) + '..' : name;
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
// Danger scan: EVE-KILL Query API (single POST replaces N zKill GETs)
// ---------------------------------------------------------------------------

const MAX_KILLS_PER_SYSTEM = 5;
const DANGER_SCAN_CONCURRENCY = 10;

async function scanSystemDanger(
  db: Db,
  systemIds: Set<number>,
  systemInfoMap: Map<number, SystemInfo>,
  _ctx: UserContext,
): Promise<Map<number, DangerSystem>> {
  const ids = [...systemIds];
  if (ids.length === 0) return new Map();

  console.log('[danger_scan] scanning %d systems via EVE-KILL /killlist', ids.length);

  // Parallel EVE-KILL /killlist requests per system (pre-enriched, no ESI needed)
  const feedMap = new Map<number, KilllistItem[]>();
  let idx = 0;
  const next = async (): Promise<void> => {
    while (idx < ids.length) {
      const systemId = ids[idx++];
      const result = await getKilllist(db, { system_id: systemId, limit: 10 }, 60);
      if (result.ok && result.data.length > 0) {
        feedMap.set(systemId, result.data);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DANGER_SCAN_CONCURRENCY, ids.length) }, () => next()));

  if (feedMap.size === 0) {
    console.log('[danger_scan] no kills found');
    return new Map();
  }

  console.log('[danger_scan] %d/%d systems have kills', feedMap.size, ids.length);

  // Build DangerSystem entries from pre-enriched EVE-KILL data
  const dangerMap = new Map<number, DangerSystem>();
  for (const [systemId, feed] of feedMap) {
    const info = systemInfoMap.get(systemId);
    const npcCount = feed.filter((km) => km.is_npc === true).length;
    const pvpCount = feed.length - npcCount;
    const totalValueM = feed.reduce((s, km) => s + Math.round((km.total_value ?? 0) / 1_000_000), 0);

    const kills: RecentKill[] = feed.slice(0, MAX_KILLS_PER_SYSTEM).map((km) => ({
      time: km.killmail_time ? toMSK(km.killmail_time) : null,
      victim: km.victim_character_name ?? km.victim_corporation_name ?? null,
      victim_ship: km.ship_name ?? null,
      attacker: km.final_blow_character_name ?? km.final_blow_corporation_name ?? null,
      attacker_ship: null, // killlist doesn't include attacker ship
      value_m: Math.round((km.total_value ?? 0) / 1_000_000),
      url: `https://eve-kill.com/kill/${km.killmail_id}`,
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

  const totalEnriched = [...dangerMap.values()].reduce((s, d) => s + d.kills.length, 0);
  console.log('[danger_scan] result: %d danger systems, %d displayed kills', dangerMap.size, totalEnriched);

  return dangerMap;
}

function toMSK(utcTime: string): string {
  try {
    const d = new Date(utcTime);
    return d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) + ' MSK';
  } catch {
    return utcTime;
  }
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
