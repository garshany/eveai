import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';
import { getEveCapabilities } from './capabilities.js';
import { getLinkedCharacter } from './sso.js';
import type { UserContext } from '../auth/user-resolver.js';
import { startRouteMonitor } from '../eve-board/monitor.js';
import { isTurnAborted } from '../agent/activity.js';
import { generateBriefingFromSnapshot } from '../eve-board/briefing.js';
import { buildRouteThreatSnapshot } from '../eve-board/route-snapshot.js';
import type { RouteThreatSnapshot } from '../eve-board/route-snapshot.js';
import { subscribeEveKillFeed } from '../eve-kill/feed-poll.js';
import type { FeedEvent } from '../eve-kill/types.js';
import type { GateKill, ThreatKillmail } from '../eve-board/types.js';
import { findBestTheraShortcut, type TheraShortcut } from './thera-scout.js';
import { escapeHtml, escapeHtmlAttribute } from './route-formatting.js';

type EsiRouteFlag = 'secure' | 'shortest' | 'insecure';
type RouteFlag = EsiRouteFlag | 'thera_shortcut';

// ---------------------------------------------------------------------------
// Route monitor sender — set once from app.ts at boot time
// ---------------------------------------------------------------------------

let routeMonitorSender: ((chatId: number, text: string) => Promise<void>) | null = null;

export function setRouteMonitorSender(
  sender: (chatId: number, text: string) => Promise<void>,
): void {
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
  killmail_time: string | null;
  killmail_id: number;
  victim: string | null;
  victim_ship: string | null;
  attacker: string | null;
  attacker_ship: string | null;
  value_m: number | null;
  url: string;
  threat: ThreatKillmail;
};

type DangerSystem = {
  systemId: number;
  name: string;
  sec: number;
  kills_1h: number;
  pvp: number;
  npc: number;
  total_value_m: number;
  /** Number of kills represented by total_value_m's bounded detail sample. */
  value_resolved_kills: number;
  kills: RecentKill[];
  gate_camps: GateKill[];
};

type DangerScanResult = {
  systems: Map<number, DangerSystem>;
  truncated: boolean;
  requestCount: number;
  error: string | null;
  snapshot: RouteThreatSnapshot | null;
};

type RouteVariant = {
  flag: EsiRouteFlag;
  system_ids: number[];
  jumps: number;
  min_sec: number;
  safe_count: number;
  total_kills_1h: number;
  total_value_m: number;
  /** Coverage of total_value_m against total_kills_1h. */
  value_resolved_kills: number;
  danger_systems: DangerSystem[];
  systems: string[];
};

type AutopilotMode = 'none' | 'exact_route' | 'destination_only' | 'wh_shortcut';

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
  const flags: EsiRouteFlag[] = ['secure', 'shortest', 'insecure'];
  const routeResults = await Promise.all(
    flags.map((flag) => fetchRoute(db, originInfo.id, destInfo.id, flag, args.avoid ?? [], ctx)),
  );

  let theraShortcut: TheraShortcut | null = null;
  let shortcutMonitorSystemIds: number[] | null = null;
  const shortestJumpCount = routeResults
    .filter((route): route is number[] => route !== null && route.length > 0)
    .reduce((best, route) => Math.min(best, route.length - 1), Number.POSITIVE_INFINITY);
  if (Number.isFinite(shortestJumpCount) && shortestJumpCount >= 8) {
    try {
      theraShortcut = await findBestTheraShortcut(
        db,
        originInfo.id,
        destInfo.id,
        shortestJumpCount,
        originInfo.name,
        destInfo.name,
      );
    } catch (err) {
      console.log('[plan_route] Thera shortcut check failed: %s', err instanceof Error ? err.message : String(err));
    }
  }
  if (args.prefer === 'thera_shortcut' && theraShortcut) {
    const shortcut = theraShortcut;
    const [entryLeg, exitLeg] = await Promise.all([
      fetchRoute(db, originInfo.id, shortcut.entry_system_id, 'shortest', [], ctx),
      fetchRoute(db, shortcut.exit_system_id, destInfo.id, 'shortest', [], ctx),
    ]);
    const entryLegValid = entryLeg?.[0] === originInfo.id
      && entryLeg[entryLeg.length - 1] === shortcut.entry_system_id;
    const exitLegValid = exitLeg?.[0] === shortcut.exit_system_id
      && exitLeg[exitLeg.length - 1] === destInfo.id;
    if (entryLegValid && exitLegValid) {
      shortcutMonitorSystemIds = normalizeRouteSystems([
        ...entryLeg,
        shortcut.hub_system_id,
        ...exitLeg,
      ]);
    } else {
      console.warn('[plan_route] Thera shortcut legs unavailable; falling back to shortest route');
      theraShortcut = null;
    }
  }
  // Once shortcut discovery has completed, normalize the requested mode to
  // the route we will actually fly. Every downstream consumer (autopilot,
  // summary, briefing, and monitor) must use the same effective selection.
  const effectivePrefer: RouteFlag | undefined = args.prefer === 'thera_shortcut' && !theraShortcut
    ? 'shortest'
    : args.prefer;
  if (!routeResults.some((route) => route && route.length > 0)) {
    return {
      ok: false,
      origin: originInfo,
      destination: destInfo,
      routes: [],
      autopilot_set: false,
      autopilot_mode: 'none',
      error: 'No ESI route is available between the requested systems.',
      formatted_summary: 'Маршруты не найдены. Автопилот и мониторинг не запущены.',
    };
  }

  // 3. Collect all unique system IDs across all routes
  const allSystemIds = new Set<number>();
  for (const route of routeResults) {
    if (route) for (const id of route) allSystemIds.add(id);
  }
  for (const id of shortcutMonitorSystemIds ?? []) allSystemIds.add(id);

  // 4. Resolve system info from SDE
  const systemInfoMap = resolveSystemBatch(db, allSystemIds);

  // Capture route events while the single shared baseline is being built. The
  // monitor subscribes before this temporary capture is released, closing the
  // snapshot-to-live handoff without issuing a second baseline request.
  const capturedFeedEvents: FeedEvent[] = [];
  let captureOverflow = false;
  let releaseCaptureBarrier = (): void => {};
  let rejectCaptureBarrier = (_error: Error): void => {};
  let captureBarrierFailure: Error | null = null;
  const captureBarrier = new Promise<void>((resolve, reject) => {
    releaseCaptureBarrier = resolve;
    rejectCaptureBarrier = reject;
  });
  const unsubscribeFeedCapture = routeMonitorSender && args.set_autopilot !== false && ctx.chatId !== undefined
    ? subscribeEveKillFeed(async (event) => {
      if (!event.killmail.solarSystemId || !allSystemIds.has(event.killmail.solarSystemId)) return;
      if (capturedFeedEvents.length >= 2_500) {
        captureOverflow = true;
        // This listener is awaited by the durable global poller. Rejecting the
        // event keeps its sequence uncommitted, so it is retried after this
        // temporary listener is replaced by the permanent route monitor. The
        // local cap therefore applies backpressure instead of dropping the
        // snapshot-to-live handoff event.
        throw new Error('route live handoff buffer reached its local cap');
      }
      capturedFeedEvents.push(event);
      // Do not acknowledge this awaited feed listener while the event exists
      // only in RAM. Once the permanent monitor listener is registered (or the
      // route attempt has failed), finally releases the barrier. A process crash
      // before that point leaves the durable global cursor unchanged, so the
      // event is replayed after restart instead of disappearing in the handoff.
      await captureBarrier;
    })
    : () => {};
  const releaseFeedCapture = (): void => {
    unsubscribeFeedCapture();
    if (captureBarrierFailure && capturedFeedEvents.length > 0) {
      rejectCaptureBarrier(captureBarrierFailure);
    } else {
      releaseCaptureBarrier();
    }
  };

  try {
    // 5. Danger scan: EVE-KILL last hour for ALL unique systems
    const dangerScan = await scanSystemDanger(db, allSystemIds, systemInfoMap);
    if (dangerScan.error || captureOverflow) {
      const reason = captureOverflow ? 'live handoff buffer exceeded its local cap' : dangerScan.error!;
      return {
        ok: false,
        origin: originInfo,
        destination: destInfo,
        routes: [],
        autopilot_set: false,
        autopilot_mode: 'none',
        error: `EVE-KILL route baseline unavailable: ${reason}`,
        formatted_summary: [
          `<b>${escapeHtml(originInfo.name)} → ${escapeHtml(destInfo.name)}</b>`,
          '⚪ Данные об активности EVE-KILL временно недоступны.',
          'Маршрут и автопилот не выставлены: отсутствие killmail-данных нельзя считать подтверждением безопасности.',
        ].join('\n'),
      };
    }
    const dangerMap = dangerScan.systems;

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
  const theraRiskRoute = shortcutMonitorSystemIds && shortcutMonitorSystemIds.length > 0
    ? buildRouteVariant('shortest', shortcutMonitorSystemIds, systemInfoMap, dangerMap)
    : null;

  // 6. Set autopilot for the preferred route (skip for thera_shortcut — handled below)
  let autopilotSet = false;
  let autopilotMode: AutopilotMode = 'none';
  if (args.set_autopilot !== false && effectivePrefer !== 'thera_shortcut' && routes.length > 0) {
    const preferred = effectivePrefer
      ? routes.find((r) => r.flag === effectivePrefer) ?? routes[0]
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

  // 7b. If prefer=thera_shortcut, set autopilot waypoints for the WH route
  if (effectivePrefer === 'thera_shortcut' && args.set_autopilot !== false && theraShortcut) {
    const shortcutAutopilot = await setShortcutAutopilot(
      db, originInfo.id, theraShortcut.entry_system_id, theraShortcut.exit_system_id, destInfo.id, ctx,
    );
    autopilotSet = shortcutAutopilot.ok;
    autopilotMode = shortcutAutopilot.mode;
  }

  let formattedSummary = formatRouteSummary(
    originInfo, destInfo, routes, autopilotMode,
    effectivePrefer === 'thera_shortcut' ? 'shortest' : effectivePrefer,
    theraShortcut,
    effectivePrefer === 'thera_shortcut',
    dangerScan,
    effectivePrefer === 'thera_shortcut' ? theraRiskRoute : null,
  );

  if (theraShortcut && args.prefer !== 'thera_shortcut') {
    formattedSummary += '\n\n' + formatTheraShortcut(theraShortcut);
  }

  const linked = getLinkedCharacter(db, ctx);
  const characterId = linked?.characterId ?? 0;
  const chatId = ctx.chatId ?? ctx.userId;

  // Get the preferred route's system IDs for monitoring
  let monitorSystemIds: number[];
  let preferredRoute: RouteVariant;
  if (effectivePrefer === 'thera_shortcut' && theraShortcut) {
    preferredRoute = routes.find((r) => r.flag === 'shortest') ?? routes[0];
    monitorSystemIds = shortcutMonitorSystemIds ?? [];
  } else {
    preferredRoute = effectivePrefer
      ? routes.find((r) => r.flag === effectivePrefer) ?? routes[0]
      : routes.find((r) => r.flag === 'secure') ?? routes[0];
    const prefIndex = flags.indexOf(preferredRoute.flag);
    monitorSystemIds = routeResults[prefIndex] ?? [];
  }

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
      if (dangerScan.error) throw new Error('route kill baseline unavailable');
      const briefingDangerSystems = effectivePrefer === 'thera_shortcut' && theraRiskRoute
        ? theraRiskRoute.danger_systems
        : preferredRoute.danger_systems;
      const briefingSnapshot = briefingDangerSystems.map((system) => ({
        systemId: system.systemId,
        name: system.name,
        sec: system.sec,
        kills_1h: system.kills_1h,
        total_value_m: system.total_value_m,
        recentKills: system.kills.map((kill) => kill.threat),
        gate_camps: system.gate_camps.map((gc) => ({
          connectedSystemName: gc.connectedSystemName,
          killCount: gc.killCount,
          recentKills: gc.recentKills,
        })),
      }));
      const briefing = await generateBriefingFromSnapshot(
        db,
        monitorSystemIds,
        briefingSnapshot,
        originInfo.name,
        destInfo.name,
        characterId,
        shipTypeId,
      );
      if (briefing) {
        formattedSummary += '\n\n' + briefing;
      }
    } catch (err) {
      console.log('[plan_route] briefing generation failed: %s', err instanceof Error ? err.message : String(err));
    }

    // Auto-start route monitor only when autopilot is actually active.
    // Requires a real chat lane: a bare userId is not a valid outbound
    // address and would misroute monitor alerts.
    if (autopilotSet && routeMonitorSender && !isTurnAborted()) {
      if (ctx.chatId === undefined) {
        console.warn('[plan_route] skipping route monitor: no chat lane in context');
      } else {
        try {
          const handoffAccepted = await startRouteMonitor(
            db,
            chatId,
            characterId,
            monitorSystemIds,
            shipTypeId,
            shipName,
            routeMonitorSender,
            {
              baseline: dangerScan.snapshot ?? undefined,
              initialEvents: capturedFeedEvents.filter(
                (event) => event.killmail.solarSystemId !== undefined
                  && monitorSystemIds.includes(event.killmail.solarSystemId),
              ),
            },
          );
          if (!handoffAccepted) {
            captureBarrierFailure = new Error('route monitor did not accept the captured feed handoff');
          }
        } catch (error) {
          captureBarrierFailure = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
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
  } finally {
    releaseFeedCapture();
  }
}

function formatRouteSummary(
  origin: SystemInfo,
  dest: SystemInfo,
  routes: RouteVariant[],
  autopilotMode: AutopilotMode,
  preferFlag?: RouteFlag,
  theraShortcut?: TheraShortcut | null,
  theraSelected?: boolean,
  dangerScan?: DangerScanResult,
  selectedRiskRoute?: RouteVariant | null,
): string {
  if (routes.length === 0) return 'Маршруты не найдены.';

  const esc = escapeHtml;
  const lines: string[] = [];
  const preferred = selectedRiskRoute ?? (preferFlag && routes.find((route) => route.flag === preferFlag))
    ?? routes.find((route) => route.flag === 'secure')
    ?? routes[0];
  const dangerCount = preferred.danger_systems.length;

  // Header — when thera_shortcut is selected, show it as the chosen route
  lines.push(`<b>${esc(origin.name)} → ${esc(dest.name)}</b>`);
  if (theraSelected && theraShortcut) {
    lines.push(`\u{1F300} Выбран: WH шорткат | ${theraShortcut.total_jumps} прыжков (через ${esc(theraShortcut.hub_system)}, экономия ${theraShortcut.saved_jumps})`);
    lines.push(`Автопилот: ${esc(describeAutopilotMode(autopilotMode))}`);
  } else {
    const riskEmoji = describeRouteRiskEmoji(preferred, dangerCount);
    lines.push(`${riskEmoji} Выбран: ${esc(preferred.flag)} | ${preferred.jumps} прыжков | мин. сек: ${preferred.min_sec.toFixed(1)} | киллов/ч: ${preferred.total_kills_1h} | ${formatValueSample(preferred.total_value_m, preferred.value_resolved_kills, preferred.total_kills_1h)}`);
    lines.push(`Автопилот: ${esc(describeAutopilotMode(autopilotMode))} (${esc(preferred.flag)})`);
    const alternativeHint = describeAlternativeHint(routes, preferred);
    if (alternativeHint) {
      lines.push(alternativeHint);
    }
  }

  // Route comparison table — include WH shortcut row when available
  lines.push('');
  lines.push('<code>');
  lines.push('         прыж  сек   kills');
  for (const route of routes) {
    const isSelected = !theraSelected && route.flag === preferred.flag;
    const marker = isSelected ? '>' : ' ';
    lines.push(`${marker}${formatVariantRow(route)}`);
  }
  if (theraShortcut) {
    const marker = theraSelected ? '>' : ' ';
    lines.push(`${marker}thera   ${String(theraShortcut.total_jumps).padStart(3)}  ${theraShortcut.entry_class === 'hs' ? '0.5' : '-1.0'}     -`);
  }
  lines.push('</code>');

  lines.push('');
  if (theraSelected && theraShortcut) {
    lines.push(formatTheraShortcut(theraShortcut));
  } else {
    lines.push(`Ключевые точки: <code>${esc(buildRoutePreview(preferred))}</code>`);
  }

  const killboardLines = buildSelectedRouteKillSummary(preferred, dangerScan);
  if (killboardLines.length > 0) {
    lines.push('');
    lines.push(...killboardLines);
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

function buildSelectedRouteKillSummary(
  route: RouteVariant,
  scan?: DangerScanResult,
): string[] {
  if (scan?.error) {
    return ['EVE-KILL срез: данные временно недоступны; маршрут нельзя считать подтверждённо тихим.'];
  }
  if (route.danger_systems.length === 0) {
    const suffix = scan?.truncated ? ' Срез ограничен локальным лимитом.' : '';
    return [`EVE-KILL срез: на выбранной трассе свежих killmail за последний час не видно.${suffix}`];
  }

  const lines = ['EVE-KILL срез:'];
  if (scan?.truncated) lines.push('- Результат ограничен локальным лимитом; показана неполная выборка.');
  for (const system of route.danger_systems.slice(0, 2)) {
    const campLabel = system.gate_camps.length > 0
      ? ` \u{26A0}\u{FE0F} CAMP`
      : '';
    lines.push(`- ${escapeHtml(system.name)} ${system.sec.toFixed(1)}: ${system.kills_1h} PvP, ${formatValueSample(system.total_value_m, system.value_resolved_kills, system.kills_1h)}${campLabel}`);
    if (system.gate_camps.length > 0) {
      for (const gc of system.gate_camps.slice(0, 2)) {
        lines.push(`  \u{1F6A7} Гейт → ${escapeHtml(gc.connectedSystemName)}: ${gc.killCount} kill(s)${gc.recentKills > 0 ? ', свежие!' : ''}`);
      }
    }
    for (const kill of system.kills.slice(0, 2)) {
      const victimShip = escapeHtml(kill.victim_ship ?? '?');
      const victim = escapeHtml(kill.victim ?? '?');
      const attacker = escapeHtml(kill.attacker ?? '?');
      const value = kill.value_m && kill.value_m > 0 ? ` ${kill.value_m}M` : '';
      const time = kill.time ?? 'недавно';
      const link = kill.url ? ` <a href="${escapeHtmlAttribute(kill.url)}">EVE-KILL</a>` : '';
      lines.push(`  ${time} ${victimShip}${value} ${victim} ← ${attacker}${link}`);
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

function normalizeRouteSystems(systemIds: number[]): number[] {
  return systemIds.filter((systemId, index) =>
    Number.isSafeInteger(systemId)
    && systemId > 0
    && (index === 0 || systemId !== systemIds[index - 1]),
  );
}

async function fetchRoute(
  db: Db,
  originId: number,
  destId: number,
  flag: EsiRouteFlag,
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
  // Ctrl-C mid-tool (route/danger fetches above take seconds): an abandoned
  // turn must not change the player's in-game autopilot.
  if (isTurnAborted()) return { ok: false, mode: 'none' };

  await getEveCapabilities(db, 'route_autopilot', ctx);

  try {
    for (let index = 0; index < waypoints.length; index += 1) {
      // Abort can land between waypoint writes — stop mid-route rather than
      // keep changing the player's autopilot after Ctrl-C.
      if (isTurnAborted()) return { ok: false, mode: 'none' };
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

  if (isTurnAborted()) return { ok: false, mode: 'none' };
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

/**
 * Set autopilot waypoints for a WH shortcut route:
 *   origin → entry_system (gates) → [manual WH → Thera → manual WH] → exit_system → destination (gates)
 *
 * Sets 3 waypoints: entry_system, exit_system, destination.
 */
async function setShortcutAutopilot(
  db: Db,
  _originId: number,
  entrySystemId: number,
  exitSystemId: number,
  destinationId: number,
  ctx: UserContext,
): Promise<{ ok: boolean; mode: AutopilotMode }> {
  // Same abort guard as setAutopilotRoute: no in-game writes after Ctrl-C.
  if (isTurnAborted()) return { ok: false, mode: 'none' };
  await getEveCapabilities(db, 'route_autopilot', ctx);

  const waypoints = [entrySystemId, exitSystemId, destinationId];
  try {
    for (let i = 0; i < waypoints.length; i++) {
      if (isTurnAborted()) return { ok: false, mode: 'none' };
      const result = await callEsiOperation(db, 'post_ui_autopilot_waypoint', {
        destination_id: waypoints[i],
        clear_other_waypoints: i === 0,
        add_to_beginning: false,
      }, ctx);
      if (!result.ok) {
        throw new Error(result.error);
      }
    }
    console.log('[plan_route] WH shortcut autopilot set: entry=%d exit=%d dest=%d', entrySystemId, exitSystemId, destinationId);
    return { ok: true, mode: 'wh_shortcut' };
  } catch (err) {
    console.log('[plan_route] WH shortcut autopilot failed: %s', err instanceof Error ? err.message : String(err));
    return { ok: false, mode: 'none' };
  }
}

function buildRouteVariant(
  flag: EsiRouteFlag,
  systemIds: number[],
  systemInfoMap: Map<number, SystemInfo>,
  dangerMap: Map<number, DangerSystem>,
): RouteVariant {
  let minSec = 1.0;
  const systemNames: string[] = [];
  const dangerSystems: DangerSystem[] = [];
  let totalKills = 0;
  let totalValue = 0;
  let valueResolvedKills = 0;

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
      valueResolvedKills += danger.value_resolved_kills;
    }
  }

  dangerSystems.sort((a, b) => b.kills_1h - a.kills_1h);

  return {
    flag,
    system_ids: [...systemIds],
    jumps: systemIds.length - 1,
    min_sec: Math.round(minSec * 10) / 10,
    safe_count: systemIds.length - dangerSystems.length,
    total_kills_1h: totalKills,
    total_value_m: totalValue,
    value_resolved_kills: valueResolvedKills,
    danger_systems: dangerSystems,
    systems: systemNames,
  };
}

// ---------------------------------------------------------------------------
// Shared one-hour EVE-KILL route baseline
// ---------------------------------------------------------------------------

async function scanSystemDanger(
  db: Db,
  systemIds: Set<number>,
  systemInfoMap: Map<number, SystemInfo>,
): Promise<DangerScanResult> {
  const ids = [...systemIds];
  if (ids.length === 0) {
    return { systems: new Map(), truncated: false, requestCount: 0, error: null, snapshot: null };
  }

  console.log('[danger_scan] scanning %d systems via EVE-KILL', ids.length);
  const snapshot = await buildRouteThreatSnapshot(db, ids);
  const systems = new Map<number, DangerSystem>();
  for (const entry of snapshot.systems) {
    const info = systemInfoMap.get(entry.systemId);
    const kills: RecentKill[] = entry.recentKills.map((kill) => ({
      time: kill.time_msk,
      killmail_time: kill.killmail_time ?? null,
      killmail_id: kill.killmail_id,
      victim: kill.victim_character_name ?? null,
      victim_ship: kill.ship_name ?? null,
      attacker: kill.final_blow_character_name ?? null,
      attacker_ship: kill.final_blow_ship_name ?? null,
      value_m: kill.total_value === undefined ? null : Math.round(kill.total_value / 1_000_000),
      url: kill.eve_kill_url,
      threat: kill,
    }));
    systems.set(entry.systemId, {
      systemId: entry.systemId,
      name: info?.name ?? entry.name,
      sec: info?.sec ?? entry.sec,
      kills_1h: entry.pvpKills,
      pvp: entry.pvpKills,
      npc: entry.npcKills,
      total_value_m: entry.totalValueM,
      value_resolved_kills: entry.valueResolvedKills,
      kills,
      gate_camps: entry.gateKills,
    });
  }

  const campCount = [...systems.values()].reduce((sum, system) => sum + system.gate_camps.length, 0);
  console.log(
    '[danger_scan] result systems=%d camps=%d truncated=%s requests=%d',
    systems.size,
    campCount,
    snapshot.truncated,
    snapshot.requestCount,
  );
  return {
    systems,
    truncated: snapshot.truncated,
    requestCount: snapshot.requestCount,
    error: snapshot.error,
    snapshot,
  };
}

function formatValueSample(valueM: number, resolvedKills: number, totalKills: number): string {
  const coverage = `${resolvedKills}/${totalKills}`;
  return resolvedKills > 0
    ? `оценка потерь по выборке ${coverage}: ${valueM}M`
    : `оценка потерь недоступна (выборка ${coverage})`;
}

function describeAutopilotMode(mode: AutopilotMode): string {
  if (mode === 'exact_route') return 'выставлен';
  if (mode === 'wh_shortcut') return 'выставлен (WH шорткат: вход → выход → цель)';
  if (mode === 'destination_only') return 'точка назначения выставлена';
  return 'нет';
}

const SHIP_SIZE_LABELS: Record<string, string> = {
  small: 'фригаты',
  medium: 'крейсера',
  large: 'BS/BC',
  xlarge: 'кэпиталы',
};

function formatTheraShortcut(thera: TheraShortcut): string {
  const esc = escapeHtml;
  const lines: string[] = [];
  const minHours = Math.min(thera.entry_remaining_hours, thera.exit_remaining_hours);
  const lifeLabel = minHours <= 0 ? 'EOL \u{26A0}\u{FE0F}' : minHours <= 4 ? `~${minHours}ч` : 'свежая';
  const shipLabel = SHIP_SIZE_LABELS[thera.max_ship_size] ?? thera.max_ship_size;

  lines.push(`\u{1F300} <b>Шорткат через ${esc(thera.hub_system)}: ~${thera.total_jumps} прыжков</b> (экономия ${thera.saved_jumps})`);
  lines.push(
    `  Вход: ${esc(thera.entry_system)} (${thera.entry_class}, ${thera.entry_jumps}j от старта)`
    + ` → ${esc(thera.hub_system)} → `
    + `Выход: ${esc(thera.exit_system)} (${thera.exit_class}, ${thera.exit_jumps}j до цели)`,
  );
  lines.push(`  WH: ${lifeLabel}, макс ${shipLabel} | Данные: EVE-Scout`);
  return lines.join('\n');
}
