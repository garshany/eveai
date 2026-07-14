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
import { callEsiOperation } from '../eve/esi-client.js';
import { assessShip, analyzeKillPattern, scoreThreat, detectGankWindow } from './threat.js';
import type {
  RouteStats,
  DangerEvent,
  ThreatLevel,
  KillPattern,
  ShipAssessment,
  ThreatKillmail,
} from './types.js';
import { buildRouteThreatSnapshot } from './route-snapshot.js';

export type RouteBriefingSnapshotKill = ThreatKillmail;

export type RouteBriefingSnapshotGateCamp = {
  connectedSystemName: string;
  killCount: number;
  recentKills: number;
};

export type RouteBriefingSnapshotSystem = {
  systemId: number;
  name: string;
  sec: number;
  kills_1h: number;
  total_value_m: number;
  recentKills: RouteBriefingSnapshotKill[];
  gate_camps?: RouteBriefingSnapshotGateCamp[];
};

// ---------------------------------------------------------------------------
// SDE helpers (same pattern as monitor.ts)
// ---------------------------------------------------------------------------

function resolveSystemName(db: Db, systemId: number): string {
  const row = db
    .prepare('SELECT name FROM sde_systems WHERE system_id = ?')
    .get(systemId) as { name: string } | undefined;
  return row?.name ?? `System ${systemId}`;
}

type SystemJumpEntry = { system_id: number; ship_jumps: number };

async function fetchSystemJumps(db: Db, systemIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const wantedIds = new Set(systemIds);
  try {
    const result = await callEsiOperation<SystemJumpEntry[]>(
      db,
      'get_universe_system_jumps',
      {},
    );
    if (result.ok && Array.isArray(result.data)) {
      for (const entry of result.data) {
        if (wantedIds.has(entry.system_id) && entry.ship_jumps) {
          map.set(entry.system_id, entry.ship_jumps);
        }
      }
    }
  } catch {
    // non-critical
  }
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
const UNKNOWN_SHIP_TEXT = 'Оценка корпуса: данные о корабле недоступны.';

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
  systemId: number;
  routeIndex: number;
  name: string;
  sec: number;
  pattern: KillPattern;
  recentKills: ThreatKillmail[];
  threatLevel: ThreatLevel;
  threatReason: string;
  gate_camps: RouteBriefingSnapshotGateCamp[];
};

export async function generateBriefingFromSnapshot(
  db: Db,
  routeSystems: number[],
  snapshotSystems: RouteBriefingSnapshotSystem[],
  originName: string,
  destName: string,
  _characterId: number,
  shipTypeId: number,
): Promise<string> {
  const ship = assessShip(db, shipTypeId);
  const dangerSystems = buildDangerSystemsFromSnapshot(routeSystems, snapshotSystems, ship);
  const jumpMap = await fetchSystemJumps(db, routeSystems);
  const gankWindow = detectGankWindow(dangerSystems.map((system) => system.pattern));
  return formatBriefing(db, ship, dangerSystems, jumpMap, gankWindow, originName, destName, routeSystems);
}

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
  const ship = assessShip(db, shipTypeId);
  const snapshot = await buildRouteThreatSnapshot(db, routeSystems);
  if (snapshot.error) {
    return 'Предполетный EVE-KILL срез временно недоступен; отсутствие предупреждений не означает безопасный маршрут.';
  }
  const dangerSystems = buildDangerSystemsFromSnapshot(
    routeSystems,
    snapshot.systems.map((system) => ({
      systemId: system.systemId,
      name: system.name,
      sec: system.sec,
      kills_1h: system.pvpKills,
      total_value_m: system.totalValueM,
      recentKills: system.recentKills,
      gate_camps: system.gateKills,
    })),
    ship,
  );
  const gankWindow = detectGankWindow(dangerSystems.map((system) => system.pattern));
  const briefing = formatBriefing(
    db,
    ship,
    dangerSystems,
    snapshot.jumpMap,
    gankWindow,
    originName,
    destName,
    routeSystems,
  );
  return snapshot.truncated
    ? `${briefing}\nОграничение: EVE-KILL срез усечён локальным лимитом результатов.`
    : briefing;
}

function buildDangerSystemsFromSnapshot(
  routeSystems: number[],
  snapshotSystems: RouteBriefingSnapshotSystem[],
  ship: ShipAssessment,
): DangerSystemInfo[] {
  const systemsById = new Map(snapshotSystems.map((system) => [system.systemId, system]));
  const dangerSystems: DangerSystemInfo[] = [];

  for (const systemId of routeSystems) {
    const snapshot = systemsById.get(systemId);
    if (!snapshot || snapshot.recentKills.length === 0) continue;

    const pattern = analyzeKillPattern(snapshot.recentKills, systemId, snapshot.name, snapshot.sec);
    const threat = scoreThreat(pattern, ship);
    dangerSystems.push({
      systemId,
      name: snapshot.name,
      sec: snapshot.sec,
      routeIndex: routeSystems.indexOf(systemId),
      pattern,
      recentKills: snapshot.recentKills
        .slice()
        .sort((left, right) => (right.killmail_time ?? '').localeCompare(left.killmail_time ?? '')),
      threatLevel: threat.level,
      threatReason: threat.reason,
      gate_camps: snapshot.gate_camps ?? [],
    });
  }

  const levelOrder: Record<ThreatLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  dangerSystems.sort((left, right) => {
    const levelDiff = levelOrder[left.threatLevel] - levelOrder[right.threatLevel];
    if (levelDiff !== 0) return levelDiff;
    return left.routeIndex - right.routeIndex;
  });

  return dangerSystems;
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
  lines.push(buildShipLine(ship));
  lines.push(`Сейчас: ${buildCurrentLine(originName, currentSystem)}`);
  lines.push(`Впереди: ${buildAheadLine(aheadSystems, destinationSystem, routeSystems, db)}`);
  lines.push(`Тактика: ${buildTacticalLine(currentSystem, aheadSystems, destinationSystem, gankWindow)}`);
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

  lines.push(buildSurvivalLine(ship));

  return lines.join('\n');
}

function buildTacticalLine(
  currentSystem: DangerSystemInfo | null,
  aheadSystems: DangerSystemInfo[],
  destinationSystem: DangerSystemInfo | null,
  gankWindow: { isOpen: boolean; reason: string },
): string {
  const nearestAhead = aheadSystems[0] ?? null;
  if (currentSystem && (currentSystem.threatLevel === 'HIGH' || currentSystem.threatLevel === 'CRITICAL')) {
    return `старт HOT: ${currentSystem.name} держит основной риск; окно ${gankWindow.isOpen ? 'приоткрыто' : 'закрыто'}.`;
  }
  if (nearestAhead && (nearestAhead.threatLevel === 'HIGH' || nearestAhead.threatLevel === 'CRITICAL')) {
    return `транзит HOT: ближайшая жёсткая точка ${nearestAhead.name} через ${nearestAhead.routeIndex} ${jumpWord(nearestAhead.routeIndex)}.`;
  }
  if (nearestAhead) {
    return `транзит WARM: фоновая активность в ${nearestAhead.name}; окно ${gankWindow.isOpen ? 'прохода открыто' : 'прохода сужено'}.`;
  }
  if (destinationSystem) {
    return `транзит CLEAR: риск локален в цели ${destinationSystem.name}; окно ${gankWindow.isOpen ? 'прохода открыто' : 'прохода сужено'}.`;
  }
  return `транзит CLEAR: трасса выглядит чистой; окно ${gankWindow.isOpen ? 'прохода открыто' : 'прохода сужено'}.`;
}

function hasUsableShipAssessment(ship: ShipAssessment): boolean {
  if (!Number.isFinite(ship.shipTypeId) || ship.shipTypeId <= 0) return false;
  if (!Number.isFinite(ship.ehp) || ship.ehp <= 0) return false;
  if (!Number.isFinite(ship.alignTime) || ship.alignTime <= 0) return false;
  const normalizedName = ship.shipName.trim();
  if (!normalizedName || normalizedName.startsWith('#') || /^Type\s+\d+$/i.test(normalizedName)) return false;
  return true;
}

function buildShipLine(ship: ShipAssessment): string {
  if (!hasUsableShipAssessment(ship)) {
    return 'Корабль: неизвестен | Базовая оценка недоступна';
  }
  return `Корабль: ${ship.shipName} | Базовый EHP: ${ship.ehp.toLocaleString('ru-RU')} | Align: ${ship.alignTime}s`;
}

function buildSurvivalLine(ship: ShipAssessment): string {
  if (!hasUsableShipAssessment(ship)) {
    return UNKNOWN_SHIP_TEXT;
  }
  return `Оценка корпуса: ${SURVIVAL_TEXT[ship.survivalChance]}`;
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
  const campBrief = formatGateCampBrief(currentSystem.gate_camps);
  const campSuffix = campBrief ? `; ${campBrief}` : '; устойчивого лагеря не видно';
  return `${originName} — ${currentSystem.pattern.killCount} PvP за последний час, последнее ${timePart}${campSuffix}.`;
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

function formatKillLine(systemName: string, kill: ThreatKillmail): string {
  const age = formatKillAge(kill.killmail_time);
  const victimShip = kill.ship_name ?? '?';
  const valueM = Math.round((kill.total_value ?? 0) / 1_000_000);
  const victimName = kill.victim_character_name ?? '?';
  const attackerName = kill.final_blow_character_name ?? '?';
  const attackerCount = kill.attacker_count ?? 1;
  const attackerPart = attackerCount > 1 ? `${attackerName} +${attackerCount - 1}` : attackerName;
  const valuePart = valueM > 0 ? ` ${valueM}M` : '';
  return `${systemName} — ${age} ${victimShip}${valuePart} ${victimName} ← ${attackerPart}`;
}

function formatKillAge(value: string | undefined): string {
  const minutes = value ? minutesSinceIso(value) : null;
  if (minutes === null) return 'недавно';
  if (minutes < 1) return 'только что';
  return `${minutes}м назад`;
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
  const campPart = formatGateCampBrief(system.gate_camps);
  if (system.threatLevel === 'LOW') {
    const base = `локально ${lowercaseFirst(system.threatReason)}`;
    return campPart ? `${base}; ${campPart}` : base;
  }
  const base = lowercaseFirst(system.threatReason);
  return campPart ? `${base}; ${campPart}` : base;
}

function formatGateCampBrief(camps: RouteBriefingSnapshotGateCamp[]): string {
  if (camps.length === 0) return '';
  const top = camps[0];
  const fresh = top.recentKills > 0 ? ', свежий' : '';
  return `гейткемп на гейте → ${top.connectedSystemName} (${top.killCount} kill${fresh})`;
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
