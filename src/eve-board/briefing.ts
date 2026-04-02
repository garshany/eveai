/**
 * Route briefing and post-route report generator.
 *
 * Two functions:
 *   generateBriefing() — pre-flight danger assessment, ship check, recommendations
 *   generateReport()   — post-flight summary with stats, events, rating
 *
 * All output is formatted Russian text ready to send via Telegram.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';
import type { KilllistItem } from '../eve-kill/client.js';
import { assessShip, analyzeKillPattern, scoreThreat, detectGankWindow } from './threat.js';
import type { RouteStats, DangerEvent, ThreatLevel, KillPattern, ShipAssessment } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Systems with sec >= 1.0 are fully safe — skip scanning. */
const SAFE_SEC_THRESHOLD = 1.0;
const BRIEFING_SCAN_WINDOW_MINUTES = 60;

// ---------------------------------------------------------------------------
// zKB fetch (direct — EVE-KILL killlist doesn't filter by system_id)
// ---------------------------------------------------------------------------

type ZkbItem = {
  killmail_id: number;
  zkb?: { hash?: string; totalValue?: number; npc?: boolean; solo?: boolean };
};

async function fetchZkbForBriefing(systemId: number): Promise<ZkbItem[]> {
  const url = `${config.zkill.baseUrl}kills/systemID/${systemId}/pastSeconds/3600/`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': config.zkill.userAgent },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((item: unknown): item is ZkbItem =>
      !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).killmail_id === 'number',
    );
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// ESI enrichment (same pattern as monitor.ts)
// ---------------------------------------------------------------------------

const MAX_ENRICH_PER_SYSTEM = 3;

type EsiKillmailVictim = { ship_type_id?: number; character_id?: number };
type EsiKillmailAttacker = { character_id?: number; final_blow?: boolean };
type EsiKillmail = {
  killmail_time?: string;
  victim?: EsiKillmailVictim;
  attackers?: EsiKillmailAttacker[];
};

async function enrichZkbKills(
  db: Db,
  items: ZkbItem[],
): Promise<KilllistItem[]> {
  type PendingKill = {
    item: ZkbItem;
    km: EsiKillmail;
    victim: EsiKillmailVictim;
    attackers: EsiKillmailAttacker[];
    fb: EsiKillmailAttacker | undefined;
    shipInfo: { typeName: string; groupName: string } | null;
    victimShipTypeId: number | undefined;
  };

  const results: KilllistItem[] = [];
  const pending: PendingKill[] = [];
  const idsToResolve = new Set<number>();

  for (const item of items.slice(0, MAX_ENRICH_PER_SYSTEM)) {
    const hash = item.zkb?.hash;
    if (!hash) {
      results.push(zkbToKilllistFallback(item));
      continue;
    }

    try {
      const r = await callEsiOperation<EsiKillmail>(
        db,
        'get_killmails_killmail_id_killmail_hash',
        { killmail_id: item.killmail_id, killmail_hash: hash },
      );

      if (!r.ok || !r.data) {
        results.push(zkbToKilllistFallback(item));
        continue;
      }

      const km = r.data;
      const victim = km.victim ?? {};
      const attackers = km.attackers ?? [];
      const fb = attackers.find((a) => a.final_blow === true) ?? attackers[0];

      const victimShipTypeId = victim.ship_type_id;
      const shipInfo = victimShipTypeId ? resolveTypeGroup(db, victimShipTypeId) : null;

      pending.push({
        item,
        km,
        victim,
        attackers,
        fb,
        shipInfo,
        victimShipTypeId,
      });
      if (victim.character_id && victim.character_id > 0) idsToResolve.add(victim.character_id);
      if (fb?.character_id && fb.character_id > 0) idsToResolve.add(fb.character_id);
    } catch {
      results.push(zkbToKilllistFallback(item));
    }
  }

  const nameMap = await resolveCharacterNames(db, idsToResolve);
  for (const entry of pending) {
    results.push({
      killmail_id: entry.item.killmail_id,
      killmail_time: typeof entry.km.killmail_time === 'string' ? entry.km.killmail_time : undefined,
      total_value: entry.item.zkb?.totalValue ?? 0,
      is_npc: entry.item.zkb?.npc ?? false,
      is_solo: entry.item.zkb?.solo ?? false,
      attacker_count: entry.attackers.length,
      ship_type_id: entry.victimShipTypeId,
      ship_name: entry.shipInfo?.typeName ?? undefined,
      ship_group_name: entry.shipInfo?.groupName ?? undefined,
      victim_character_id: entry.victim.character_id,
      victim_character_name: entry.victim.character_id ? nameMap.get(entry.victim.character_id) : undefined,
      final_blow_character_id: entry.fb?.character_id,
      final_blow_character_name: entry.fb?.character_id ? nameMap.get(entry.fb.character_id) : undefined,
    });
  }

  return results;
}

async function resolveCharacterNames(db: Db, ids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.size === 0) return map;
  try {
    const result = await callEsiOperation<Array<{ id: number; name: string }>>(
      db,
      'post_universe_names',
      { ids: JSON.stringify([...ids].slice(0, 100)) },
    );
    if (result.ok && Array.isArray(result.data)) {
      for (const entry of result.data) {
        if (entry.id && entry.name) map.set(entry.id, entry.name);
      }
    }
  } catch {
    // non-critical: detail lines degrade gracefully without names
  }
  return map;
}

function zkbToKilllistFallback(item: ZkbItem): KilllistItem {
  return {
    killmail_id: item.killmail_id,
    total_value: item.zkb?.totalValue ?? 0,
    is_npc: item.zkb?.npc ?? false,
    is_solo: item.zkb?.solo ?? false,
    attacker_count: 1,
    ship_name: undefined,
    ship_group_name: undefined,
    final_blow_character_id: undefined,
  };
}

function resolveTypeGroup(
  db: Db,
  typeId: number,
): { typeName: string; groupName: string } | null {
  const row = db.prepare(`
    SELECT t.name AS type_name, g.name AS group_name
    FROM sde_types t
    JOIN sde_groups g ON g.group_id = t.group_id
    WHERE t.type_id = ?
  `).get(typeId) as { type_name: string; group_name: string } | undefined;
  if (!row) return null;
  return { typeName: row.type_name, groupName: row.group_name };
}

// ---------------------------------------------------------------------------
// SDE helpers (same pattern as monitor.ts)
// ---------------------------------------------------------------------------

const SEC_SQL =
  "coalesce(json_extract(data_json, '$.securityStatus'), json_extract(data_json, '$.security'))";

function resolveSystemName(db: Db, systemId: number): string {
  const row = db
    .prepare('SELECT name FROM sde_systems WHERE system_id = ?')
    .get(systemId) as { name: string } | undefined;
  return row?.name ?? `System ${systemId}`;
}

function resolveSystemSec(db: Db, systemId: number): number {
  const row = db
    .prepare(`SELECT ${SEC_SQL} as sec FROM sde_systems WHERE system_id = ?`)
    .get(systemId) as { sec: number | null } | undefined;
  if (!row?.sec || typeof row.sec !== 'number') return 0;
  return Math.round(row.sec * 10) / 10;
}

// ---------------------------------------------------------------------------
// ESI system jumps (public, bulk endpoint)
// ---------------------------------------------------------------------------

type SystemJumpEntry = { system_id: number; ship_jumps: number };

async function fetchSystemJumps(db: Db, systemIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const wantedIds = new Set(systemIds);
  try {
    const result = await callEsiOperation<SystemJumpEntry[]>(
      db, 'get_universe_system_jumps', {},
    );
    if (result.ok && Array.isArray(result.data)) {
      for (const entry of result.data) {
        // Filter client-side — ESI returns all systems
        if (wantedIds.has(entry.system_id) && entry.ship_jumps) {
          map.set(entry.system_id, entry.ship_jumps);
        }
      }
    }
  } catch { /* non-critical */ }
  return map;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const SURVIVAL_TEXT: Record<ShipAssessment['survivalChance'], string> = {
  DEAD: '\u{1F480} Базовая живучесть минимальна (с фитом может быть выше)',
  UNLIKELY: '\u{26A0}\u{FE0F} Базовая живучесть низкая (с фитом будет выше)',
  POSSIBLE: '\u{1F7E1} Базовая живучесть средняя (с фитом будет выше)',
  SAFE: '\u{1F7E2} Высокая базовая живучесть',
};

function jumpWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'прыжок';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'прыжка';
  return 'прыжков';
}

// ---------------------------------------------------------------------------
// 1. generateBriefing
// ---------------------------------------------------------------------------

type DangerSystemInfo = {
  routeIndex: number;
  name: string;
  sec: number;
  pattern: KillPattern;
  recentKills: KilllistItem[];
  threatLevel: ThreatLevel;
  threatReason: string;
};

/**
 * Generate a pre-route briefing: danger assessment, ship check, recommendations.
 *
 * Scans systems on the selected route with sec < 1.0 for recent
 * kill activity from EVE-KILL, scores threat against the pilot's ship, and
 * compiles a formatted Russian-language briefing string.
 */
export async function generateBriefing(
  db: Db,
  routeSystems: number[],
  originName: string,
  destName: string,
  _characterId: number,
  shipTypeId: number,
): Promise<string> {
  // Step 1: assess ship
  const ship = assessShip(db, shipTypeId);

  // Step 2: identify systems to scan on the selected route (sec < 1.0).
  // Keep route order intact so the briefing matches the actual flight path.
  const candidates: Array<{ id: number; name: string; sec: number }> = [];
  for (const sysId of routeSystems) {
    const sec = resolveSystemSec(db, sysId);
    if (sec < SAFE_SEC_THRESHOLD) {
      candidates.push({ id: sysId, name: resolveSystemName(db, sysId), sec });
    }
  }
  const systemsToScan = candidates;

  // Step 3: fetch kills and analyze patterns in parallel
  const dangerSystems: DangerSystemInfo[] = [];
  const patterns: KillPattern[] = [];

  console.log(`[briefing] scanning ${systemsToScan.length} systems: ${systemsToScan.map(s => `${s.name}(${s.sec})`).join(', ')}`);

  // Sequential scan to avoid zKB rate limit
  const scanResults: Array<{
    sys: typeof systemsToScan[0];
    pattern: KillPattern;
    enrichedKills: KilllistItem[];
    threat: { level: ThreatLevel; reason: string };
  } | null> = [];
  for (const sys of systemsToScan) {
    try {
      const feed = await fetchZkbForBriefing(sys.id);
      const pvpKills = feed.filter((k) => !k.zkb?.npc);
      console.log(`[briefing] ${sys.name}: ${feed.length} total, ${pvpKills.length} PvP`);
      if (pvpKills.length === 0) { scanResults.push(null); continue; }

      const enrichedKills = await enrichZkbKills(db, pvpKills);
      const freshKills = enrichedKills.filter(isKillWithinBriefingWindow);
      if (freshKills.length === 0) { scanResults.push(null); continue; }

      const pattern = analyzeKillPattern(freshKills, sys.id, sys.name, sys.sec);
      const threat = scoreThreat(pattern, ship);
      scanResults.push({ sys, pattern, enrichedKills: freshKills, threat });
    } catch (err) {
      console.error(`[briefing] scan error ${sys.name}:`, (err as Error).message);
      scanResults.push(null);
    }
  }

  for (const result of scanResults) {
    if (!result) continue;
    const { sys, pattern, enrichedKills, threat } = result;

    patterns.push(pattern);

    // Include ALL systems with PvP kills, not just MEDIUM+
    dangerSystems.push({
      name: sys.name,
      sec: sys.sec,
      routeIndex: routeSystems.indexOf(sys.id),
      pattern,
      recentKills: enrichedKills
        .slice()
        .sort((left, right) => (right.killmail_time ?? '').localeCompare(left.killmail_time ?? '')),
      threatLevel: threat.level,
      threatReason: threat.reason,
    });
  }

  // Sort danger systems: CRITICAL first, then HIGH, then MEDIUM
  const levelOrder: Record<ThreatLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  dangerSystems.sort((a, b) => levelOrder[a.threatLevel] - levelOrder[b.threatLevel]);

  // Step 4: fetch jump stats for route systems (ESI, public, bulk)
  const jumpMap = await fetchSystemJumps(db, routeSystems);
  console.log(`[briefing] jump stats: ${jumpMap.size} systems with data`);

  // Step 5: gank window detection
  const gankWindow = detectGankWindow(patterns);

  // Step 6: format briefing
  return formatBriefing(db, ship, dangerSystems, jumpMap, gankWindow, originName, destName, routeSystems);
}

function formatBriefing(
  db: Db,
  ship: ShipAssessment,
  dangerSystems: DangerSystemInfo[],
  jumpMap: Map<number, number>,
  gankWindow: { isOpen: boolean; reason: string },
  originName: string,
  destName: string,
  routeSystems: number[],
): string {
  const jumps = Math.max(routeSystems.length - 1, 0);
  const lines: string[] = [];
  const action = assessPreflightAction(ship, dangerSystems, gankWindow);
  const currentSystem = getCurrentDangerSystem(dangerSystems);
  const aheadSystems = getTransitDangerSystems(dangerSystems, routeSystems);
  const destinationSystem = getDestinationDangerSystem(dangerSystems, routeSystems);

  lines.push(`\u{1F6F0}\u{FE0F} Предполет | ${action.emoji} ${action.label}`);
  lines.push('');
  lines.push(`Маршрут: ${originName} → ${destName} (${jumps} прыжков)`);
  lines.push(`Корабль: ${ship.shipName} | Базовый EHP: ${ship.ehp.toLocaleString('ru-RU')} | Align: ${ship.alignTime}s`);
  lines.push(`Сейчас: ${buildCurrentLine(originName, currentSystem)}`);
  lines.push(`Впереди: ${buildAheadLine(aheadSystems, destinationSystem, routeSystems, db)}`);
  lines.push(`Действие: ${action.action}`);
  lines.push('');

  const supportLines = buildSupportLines(
    db,
    dangerSystems,
    jumpMap,
    gankWindow,
    routeSystems,
    originName,
    destName,
  );
  if (supportLines.length > 0) {
    lines.push(...supportLines);
    lines.push('');
  }

  lines.push(`Оценка корпуса: ${SURVIVAL_TEXT[ship.survivalChance]}`);

  return lines.join('\n');
}

type PreflightAction = {
  emoji: string;
  label: 'ВЫХОДИ' | 'ОСТОРОЖНО' | 'ЖДАТЬ' | 'СТОП';
  action: string;
};

function assessPreflightAction(
  ship: ShipAssessment,
  dangerSystems: DangerSystemInfo[],
  gankWindow: { isOpen: boolean; reason: string },
): PreflightAction {
  const hasCritical = dangerSystems.some(d => d.threatLevel === 'CRITICAL');
  const hasHigh = dangerSystems.some(d => d.threatLevel === 'HIGH');

  if (hasCritical && ship.survivalChance === 'DEAD') {
    return {
      emoji: '\u{1F534}',
      label: 'СТОП',
      action: 'не выходите на маршрут: активный ганк-паттерн и ваш базовый танк слишком тонкий.',
    };
  }
  if (hasCritical) {
    return {
      emoji: '\u{1F534}',
      label: 'СТОП',
      action: 'маршрут слишком горячий прямо сейчас, лучше переждать окно или выбрать другой путь.',
    };
  }
  if (hasHigh && !gankWindow.isOpen) {
    return {
      emoji: '\u{1F7E1}',
      label: 'ЖДАТЬ',
      action: 'подождите 10-20 минут или проверьте трассу скаутом перед выходом.',
    };
  }
  if (hasHigh && gankWindow.isOpen) {
    return {
      emoji: '\u{1F7E1}',
      label: 'ОСТОРОЖНО',
      action: 'окно прохода есть, но летите вручную и не зависайте на воротах или андоке.',
    };
  }
  const hasOnlyLow = dangerSystems.length > 0 && dangerSystems.every((system) => system.threatLevel === 'LOW');
  if (hasOnlyLow) {
    return {
      emoji: '\u{1F7E1}',
      label: 'ОСТОРОЖНО',
      action: 'по пути есть отдельные киллы, но свежего лагеря не видно. Летите вручную.',
    };
  }
  if (dangerSystems.length > 0) {
    return {
      emoji: '\u{1F7E1}',
      label: 'ОСТОРОЖНО',
      action: 'лететь можно, но держите локал и d-scan, не стойте на гейтах.',
    };
  }
  return {
    emoji: '\u{1F7E2}',
    label: 'ВЫХОДИ',
    action: 'маршрут сейчас чистый, можно выходить с обычной дисциплиной полёта.',
  };
}

function buildCurrentLine(originName: string, currentSystem: DangerSystemInfo | null): string {
  if (!currentSystem) {
    return `${originName} — локально тихо, свежих PvP-сигналов не видно.`;
  }

  if (currentSystem.threatLevel === 'CRITICAL' || currentSystem.threatLevel === 'HIGH') {
    return `${originName} — ${currentSystem.threatReason}`;
  }

  const minutesAgo = minutesSinceIso(currentSystem.pattern.latestKillTime);
  const timePart = minutesAgo === null ? 'недавно' : `${minutesAgo} мин назад`;
  return `${originName} — ${currentSystem.pattern.killCount} PvP за последний час, последнее ${timePart}; устойчивого лагеря не видно.`;
}

function buildAheadLine(
  aheadSystems: DangerSystemInfo[],
  destinationSystem: DangerSystemInfo | null,
  routeSystems: number[],
  db: Db,
): string {
  if (aheadSystems.length > 0) {
    const nearest = aheadSystems[0]!;
    const distance = Math.max(nearest.routeIndex, 0);
    return `${nearest.name} через ${distance} ${jumpWord(distance)} — ${nearest.threatReason.toLowerCase()}.`;
  }

  if (destinationSystem) {
    const nextSystems = routeSystems
      .slice(1, -1)
      .slice(0, 3)
      .map((systemId) => resolveSystemName(db, systemId));
    const transitPart = nextSystems.length > 0
      ? `${nextSystems.join(', ')} — транзит тихий`
      : 'между системами транзит тихий';
    return `${transitPart}; в ${destinationSystem.name} ${describeDestinationSignal(destinationSystem)}.`;
  }

  const nextSystems = routeSystems
    .slice(1, 4)
    .map((systemId) => resolveSystemName(db, systemId));

  if (nextSystems.length === 0) {
    return 'маршрут почти завершён, впереди тихо.';
  }

  return `${nextSystems.join(', ')} — свежих PvP-угроз не видно.`;
}

function buildSupportLines(
  db: Db,
  dangerSystems: DangerSystemInfo[],
  jumpMap: Map<number, number>,
  gankWindow: { isOpen: boolean; reason: string },
  routeSystems: number[],
  originName: string,
  destName: string,
): string[] {
  const lines: string[] = [];
  const orderedSystems = getSupportSystemsInRouteOrder(dangerSystems, routeSystems);

  if (orderedSystems.length > 0) {
    const topSystems = orderedSystems
      .slice(0, 3)
      .map((system) => `${formatSystemLabel(system, routeSystems)}: ${system.pattern.killCount} PvP`);
    lines.push(`Активность: ${topSystems.join(' | ')}`);
    lines.push(`Анализ: ${buildRouteAnalysis(dangerSystems, routeSystems, originName, destName)}`);

    const recentKillLines = buildRecentKillLines(dangerSystems, routeSystems);
    if (recentKillLines.length > 0) {
      lines.push('Последние киллы:');
      lines.push(...recentKillLines);
    }
  }

  if (jumpMap.size > 0) {
    const routeSystemSet = new Set(routeSystems);
    const traffic = [...jumpMap.entries()]
      .filter(([sysId]) => routeSystemSet.has(sysId))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([sysId, jumpsCount]) => `${resolveSystemName(db, sysId)} ${jumpsCount.toLocaleString('ru-RU')}`);
    if (traffic.length > 0) {
      lines.push(`Трафик: ${traffic.join(' | ')}`);
    }
  }

  if (dangerSystems.some((system) => system.threatLevel !== 'LOW')) {
    lines.push(`Окно: ${gankWindow.reason}`);
  }

  return lines;
}

function buildRouteAnalysis(
  dangerSystems: DangerSystemInfo[],
  routeSystems: number[],
  originName: string,
  destName: string,
): string {
  const currentSystem = getCurrentDangerSystem(dangerSystems);
  const transitAheadSystems = getTransitDangerSystems(dangerSystems, routeSystems);
  const destinationSystem = getDestinationDangerSystem(dangerSystems, routeSystems);
  const nearestAhead = transitAheadSystems[0] ?? null;
  const farSystems = transitAheadSystems.slice(1);

  const parts: string[] = [];
  if (currentSystem) {
    parts.push(`стартовый шум в ${currentSystem.name}`);
  } else {
    parts.push('старт тихий');
  }

  if (nearestAhead) {
    parts.push(`ближайшая транзитная PvP-точка ${nearestAhead.name} через ${nearestAhead.routeIndex} ${jumpWord(nearestAhead.routeIndex)}`);
  } else {
    parts.push(`между ${originName} и ${destName} транзитных PvP-точек нет`);
  }

  if (farSystems.length > 0) {
    parts.push(`дальше ещё ${farSystems.length} фоновых точек без явного camp-паттерна`);
  }

  if (destinationSystem) {
    parts.push(`в цели ${destinationSystem.name} ${describeDestinationSignal(destinationSystem)}`);
  }

  return parts.join('; ') + '.';
}

function buildRecentKillLines(
  dangerSystems: DangerSystemInfo[],
  routeSystems: number[],
): string[] {
  const lines: string[] = [];
  for (const system of getSupportSystemsInRouteOrder(dangerSystems, routeSystems).slice(0, 3)) {
    for (const kill of system.recentKills.slice(0, 2)) {
      lines.push(`  ${formatKillLine(formatSystemLabel(system, routeSystems), kill)}`);
      if (lines.length >= 6) return lines;
    }
  }
  return lines;
}

function formatKillLine(systemName: string, kill: KilllistItem): string {
  const age = formatKillAge(kill.killmail_time);
  const victimShip = kill.ship_name ?? '?';
  const valueM = Math.round((kill.total_value ?? 0) / 1_000_000);
  const victimName = kill.victim_character_name ?? '?';
  const attackerName = kill.final_blow_character_name ?? '?';
  const attackerCount = kill.attacker_count ?? 1;
  const attackerPart = attackerCount > 1 ? `${attackerName} +${attackerCount - 1}` : attackerName;
  const valuePart = valueM > 0 ? ` ${valueM}M` : '';
  return `${systemName} — ${age} ${victimShip}${valuePart} ${victimName} <- ${attackerPart}`;
}

function formatKillAge(value: string | undefined): string {
  const minutes = value ? minutesSinceIso(value) : null;
  if (minutes === null) return 'недавно';
  if (minutes < 1) return 'только что';
  return `${minutes}м назад`;
}

function isKillWithinBriefingWindow(kill: KilllistItem): boolean {
  const minutes = kill.killmail_time ? minutesSinceIso(kill.killmail_time) : null;
  return minutes === null || minutes <= BRIEFING_SCAN_WINDOW_MINUTES;
}

function getCurrentDangerSystem(dangerSystems: DangerSystemInfo[]): DangerSystemInfo | null {
  return dangerSystems.find((system) => system.routeIndex === 0) ?? null;
}

function getDestinationDangerSystem(
  dangerSystems: DangerSystemInfo[],
  routeSystems: number[],
): DangerSystemInfo | null {
  const destinationIndex = routeSystems.length - 1;
  return dangerSystems.find((system) => system.routeIndex === destinationIndex) ?? null;
}

function getTransitDangerSystems(
  dangerSystems: DangerSystemInfo[],
  routeSystems: number[],
): DangerSystemInfo[] {
  const destinationIndex = routeSystems.length - 1;
  return dangerSystems
    .filter((system) => system.routeIndex > 0 && system.routeIndex < destinationIndex)
    .sort((left, right) => left.routeIndex - right.routeIndex);
}

function getSupportSystemsInRouteOrder(
  dangerSystems: DangerSystemInfo[],
  routeSystems: number[],
): DangerSystemInfo[] {
  const systems: DangerSystemInfo[] = [];
  const currentSystem = getCurrentDangerSystem(dangerSystems);
  const transitSystems = getTransitDangerSystems(dangerSystems, routeSystems);
  const destinationSystem = getDestinationDangerSystem(dangerSystems, routeSystems);

  if (currentSystem) systems.push(currentSystem);
  systems.push(...transitSystems);
  if (destinationSystem) systems.push(destinationSystem);

  return systems;
}

function formatSystemLabel(
  system: DangerSystemInfo,
  routeSystems: number[],
): string {
  if (system.routeIndex === 0) return `${system.name} [старт]`;
  if (system.routeIndex === routeSystems.length - 1) return `${system.name} [цель]`;
  return system.name;
}

function describeDestinationSignal(system: DangerSystemInfo): string {
  if (system.threatLevel === 'LOW') {
    return `локально ${lowercaseFirst(system.threatReason)}`;
  }
  return lowercaseFirst(system.threatReason);
}

function lowercaseFirst(value: string): string {
  const trimmed = value.trim().replace(/\.$/, '');
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function minutesSinceIso(value: string): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60_000));
}

// ---------------------------------------------------------------------------
// 2. generateReport
// ---------------------------------------------------------------------------

type RouteRating = 'SAFE' | 'CLOSE_CALL' | 'DANGEROUS';

/**
 * Generate a post-route report from accumulated flight stats.
 */
export async function generateReport(
  stats: RouteStats,
  originName: string,
  destName: string,
  jumpsTotal: number,
): Promise<string> {
  const durationMs = Date.now() - new Date(stats.startTime).getTime();
  const durationMin = Math.round(durationMs / 60_000);
  const avgSecPerJump = jumpsTotal > 0 ? Math.round(durationMs / 1000 / jumpsTotal) : 0;

  const rating = rateRoute(stats.dangerEvents);
  const closestCall = findClosestCall(stats.dangerEvents);

  const lines: string[] = [];

  // Header
  lines.push(`\u2705 \u041C\u0430\u0440\u0448\u0440\u0443\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D: ${originName} \u2192 ${destName}`);
  lines.push('');

  // Stats
  lines.push('\u{1F4CA} \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430:');
  lines.push(`\u23F1 \u0412\u0440\u0435\u043C\u044F: ${durationMin} \u043C\u0438\u043D (${jumpsTotal} \u043F\u0440\u044B\u0436\u043A\u043E\u0432, avg ${avgSecPerJump}\u0441/\u043F\u0440\u044B\u0436\u043E\u043A)`);
  lines.push(`\u{1F480} \u0413\u0430\u043D\u043A\u043E\u0432 \u043D\u0430 \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u0435: ${stats.killsSeen}`);
  lines.push(`\u26A1 \u041E\u043F\u0430\u0441\u043D\u044B\u0445 \u0441\u043E\u0431\u044B\u0442\u0438\u0439: ${stats.dangerEvents.length}`);

  // Closest call (if any danger events)
  if (closestCall) {
    lines.push('');
    lines.push(`\u0411\u043B\u0438\u0436\u0430\u0439\u0448\u0438\u0439 \u0432\u044B\u0437\u043E\u0432: ${closestCall.systemName} \u2014 ${closestCall.description}`);
  }

  lines.push('');

  // Rating
  const ratingInfo = RATING_TEXT[rating];
  lines.push(`\u0420\u0435\u0439\u0442\u0438\u043D\u0433: ${ratingInfo.emoji} ${ratingInfo.text}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rating helpers
// ---------------------------------------------------------------------------

const RATING_TEXT: Record<RouteRating, { emoji: string; text: string }> = {
  SAFE: { emoji: '\u{1F7E2}', text: '\u0411\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 \u043F\u043E\u043B\u0451\u0442' },
  CLOSE_CALL: { emoji: '\u{1F7E1}', text: '\u0411\u044B\u043B\u0438 \u043E\u043F\u0430\u0441\u043D\u044B\u0435 \u043C\u043E\u043C\u0435\u043D\u0442\u044B' },
  DANGEROUS: { emoji: '\u{1F534}', text: '\u041E\u043F\u0430\u0441\u043D\u044B\u0439 \u043F\u0435\u0440\u0435\u043B\u0451\u0442' },
};

function rateRoute(events: DangerEvent[]): RouteRating {
  if (events.length === 0) return 'SAFE';
  const hasCritical = events.some(e => e.threatLevel === 'CRITICAL');
  if (hasCritical) return 'DANGEROUS';
  const hasHighOrCritical = events.some(e => e.threatLevel === 'HIGH' || e.threatLevel === 'CRITICAL');
  if (hasHighOrCritical) return 'CLOSE_CALL';
  return 'SAFE';
}

/**
 * Find the most severe danger event (closest call).
 * Among equal severity, pick the earliest one.
 */
function findClosestCall(events: DangerEvent[]): DangerEvent | null {
  if (events.length === 0) return null;

  const levelOrder: Record<ThreatLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  let closest: DangerEvent = events[0];
  for (const e of events) {
    if (levelOrder[e.threatLevel] < levelOrder[closest.threatLevel]) {
      closest = e;
    }
  }
  return closest;
}
