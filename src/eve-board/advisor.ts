/**
 * Route advisor — LLM-powered threat advice for HIGH/CRITICAL threat levels.
 *
 * Sends a compact context to the model and returns personalized Russian-language
 * advice (3-5 lines). Falls back to a template-based alert when the LLM is
 * unavailable or too slow.
 */

import type { Db } from '../db/sqlite.js';
import type {
  KillPattern,
  PursuitSignal,
  RouteThreatDigest,
  RouteIntelSummary,
  ShipAssessment,
  SystemThreatDigest,
  ThreatLevel,
} from './types.js';
import type { GankerIntel } from './monitor.js';
import { createNativeResponse, toNativeMessage } from '../agent/native-responses.js';

// ---------------------------------------------------------------------------
// Advisor system prompt
// ---------------------------------------------------------------------------

const ADVISOR_SYSTEM_PROMPT = [
  'Ты — бортовой аналитик безопасности EVE Online. Пилот летит по маршруту.',
  'Тебе дают данные об угрозе впереди. Дай КРАТКИЙ совет на русском (3-5 строк).',
  'Формат: эмодзи + заголовок, что происходит, конкретная рекомендация.',
  'Не используй tool calls. Только текст.',
].join('\n');

/** Advisor LLM call timeout — 10 s is plenty for a short text response. */
const ADVISOR_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateThreatAdvice(
  _db: Db,
  pattern: KillPattern,
  threat: { level: ThreatLevel; reason: string },
  ship: ShipAssessment,
  currentSystem: string,
  jumpsToThreat: number,
  routeDestination: string,
): Promise<string> {
  const prompt = buildAdvisorPrompt(
    pattern,
    threat,
    ship,
    currentSystem,
    jumpsToThreat,
    routeDestination,
  );

  try {
    const response = await withTimeout(
      createNativeResponse({
        instructions: ADVISOR_SYSTEM_PROMPT,
        items: [toNativeMessage(prompt)],
        tools: [],
      }),
      ADVISOR_TIMEOUT_MS,
    );

    if (response.outputText) {
      return response.outputText;
    }
  } catch (err) {
    console.error('[route-advisor] LLM call failed:', err);
  }

  // Fallback: template-based alert
  return buildFallbackAlert(pattern, threat, ship, currentSystem, jumpsToThreat);
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildAdvisorPrompt(
  pattern: KillPattern,
  threat: { level: ThreatLevel; reason: string },
  ship: ShipAssessment,
  currentSystem: string,
  jumpsToThreat: number,
  routeDestination: string,
): string {
  return [
    `Мой корабль: ${ship.shipName} (EHP: ${ship.ehp}, align: ${ship.alignTime}s, класс: ${ship.shipClass})`,
    `Выживаемость: ${ship.survivalChance}`,
    `Позиция: ${currentSystem}, до угрозы ${jumpsToThreat} прыжков`,
    `Цель: ${routeDestination}`,
    '',
    `Угроза в ${pattern.systemName} (${pattern.systemSec.toFixed(1)}):`,
    `- ${pattern.killCount} ганков за ${pattern.timeWindowMinutes} мин`,
    `- ${pattern.uniqueAttackers.size} уникальных атакующих`,
    `- Жертвы: ${pattern.victimShipGroups.join(', ')}`,
    `- Расчётный DPS флота: ${pattern.estimatedGankDps}`,
    `- Уровень угрозы: ${threat.level} — ${threat.reason}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Template fallback
// ---------------------------------------------------------------------------

function buildFallbackAlert(
  pattern: KillPattern,
  threat: { level: ThreatLevel; reason: string },
  ship: ShipAssessment,
  currentSystem: string,
  jumpsToThreat: number,
): string {
  const header =
    threat.level === 'CRITICAL'
      ? `\u{26A0}\u{FE0F} CRITICAL: ${pattern.systemName} (${pattern.systemSec.toFixed(1)})`
      : `\u{26A0}\u{FE0F} HIGH: ${pattern.systemName} (${pattern.systemSec.toFixed(1)})`;

  const stats = `${pattern.killCount} ганков за ${pattern.timeWindowMinutes} мин (${pattern.uniqueAttackers.size} атакующих)`;
  const shipLine = `Твой ${ship.shipName} (EHP ${ship.ehp}): ${ship.survivalChance}`;
  const recommendation = pickRecommendation(threat.level, ship.survivalChance);
  const posLine = `${jumpsToThreat} прыжков впереди (${currentSystem}) — ${recommendation}`;

  return [header, stats, shipLine, posLine].join('\n');
}

function pickRecommendation(
  level: ThreatLevel,
  survival: ShipAssessment['survivalChance'],
): string {
  if (level === 'CRITICAL' && survival === 'DEAD') {
    return 'СТОЙ! Задокься немедленно.';
  }
  if (level === 'CRITICAL') {
    return 'Крайне опасно. Подожди 15+ мин или смени маршрут.';
  }
  return 'Будь осторожен. Рассмотри альтернативный маршрут.';
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Advisor LLM call timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ===========================================================================
// Level 3 — Route Intelligence
// ===========================================================================

/** LLM call timeout for route intel summary — 15s. */
const INTEL_TIMEOUT_MS = 15_000;

const INTEL_SYSTEM_PROMPT = [
  'Ты — бортовой ИИ безопасности (ESP) корабля в EVE Online.',
  'Ты получаешь только релевантные данные о текущей обстановке на маршруте.',
  'Дай пилоту одну связную тактическую сводку без лишнего шума.',
  '',
  'Формат ответа (строго):',
  'РЕКОМЕНДАЦИЯ: СТОП|ЖДАТЬ|ВПЕРЁД|ОБХОД',
  'СОВЕТ: ровно 3 строки в формате "Сейчас:", "Впереди:", "Действие:".',
  'Называй только текущую систему, ближайшие релевантные системы впереди и действительно важные имена/корабли.',
  'Не перечисляй тихие системы и не повторяй одно и то же разными словами.',
  'ФАКТОРЫ: ключевые факторы через запятую',
].join('\n');

const ACTIONABLE_LEVELS = new Set<ThreatLevel>(['HIGH', 'CRITICAL']);

// ---------------------------------------------------------------------------
// 1. Pursuit detection
// ---------------------------------------------------------------------------

/**
 * Detect whether kills behind the pilot form a pursuit pattern —
 * kills appearing in systems progressively closer to the pilot.
 */
export function detectPursuit(
  routeSystems: number[],
  pilotIdx: number,
  recentKills: Array<{ systemId: number; time: string }>,
  windowMinutes = 15,
): PursuitSignal | null {
  const cutoff = Date.now() - windowMinutes * 60_000;

  // Keep kills in systems BEHIND the pilot (route index < pilotIdx) within the window
  const behindKills = recentKills
    .filter((k) => {
      const idx = routeSystems.indexOf(k.systemId);
      return idx >= 0 && idx < pilotIdx && new Date(k.time).getTime() >= cutoff;
    })
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  // Deduplicate systems
  const systemSet = new Set(behindKills.map((k) => k.systemId));
  if (systemSet.size < 2) return null;

  // Check approach pattern: map each kill to its route index in chronological order
  // and see if indices increase over time (getting closer to pilot)
  const killIndices = behindKills.map((k) => routeSystems.indexOf(k.systemId));

  let approaching = false;
  if (killIndices.length >= 2) {
    // Walk the chronological kills; if the trend is toward the pilot, it's a pursuit
    let rises = 0;
    let falls = 0;
    for (let i = 1; i < killIndices.length; i++) {
      if (killIndices[i] > killIndices[i - 1]) rises++;
      else if (killIndices[i] < killIndices[i - 1]) falls++;
    }
    approaching = rises > falls;
  }

  if (!approaching) return null;

  // Confidence based on system count and recency
  const mostRecentKillMs = Math.max(
    ...behindKills.map((k) => new Date(k.time).getTime()),
  );
  const minutesSinceLatest = (Date.now() - mostRecentKillMs) / 60_000;

  let confidence: PursuitSignal['confidence'];
  if (systemSet.size >= 4 || minutesSinceLatest < 5) {
    confidence = 'high';
  } else if (systemSet.size >= 3) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    systemIds: [...systemSet],
    approachingPilot: true,
    windowMinutes,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// 2. LLM-powered route intelligence summary
// ---------------------------------------------------------------------------

/**
 * Ask the LLM for a stop/wait/go recommendation based on full route context.
 * Falls back to `buildTemplateSummary` on timeout or error.
 */
export async function generateRouteIntelSummary(
  digest: RouteThreatDigest,
  shipAssessment: ShipAssessment,
  pursuit: PursuitSignal | null,
  gankerIntel: GankerIntel[],
  monitor: {
    routeSystems: number[];
    originId: number;
    destinationId: number;
    currentSystemId: number;
  },
): Promise<RouteIntelSummary> {
  if (!shouldUseLlmIntel(digest, pursuit, gankerIntel)) {
    return buildTemplateSummary(digest, pursuit, gankerIntel);
  }

  const prompt = buildIntelPrompt(digest, shipAssessment, pursuit, gankerIntel, monitor);

  try {
    const response = await withTimeout(
      createNativeResponse({
        instructions: INTEL_SYSTEM_PROMPT,
        items: [toNativeMessage(prompt)],
        tools: [],
      }),
      INTEL_TIMEOUT_MS,
    );

    if (response.outputText) {
      const parsed = parseIntelResponse(response.outputText, pursuit);
      if (parsed) return parsed;
    }
  } catch (err) {
    console.error('[route-intel] LLM call failed, falling back to template:', err);
  }

  return buildTemplateSummary(digest, pursuit, gankerIntel);
}

// ---------------------------------------------------------------------------
// Intel prompt builder
// ---------------------------------------------------------------------------

function buildIntelPrompt(
  digest: RouteThreatDigest,
  ship: ShipAssessment,
  pursuit: PursuitSignal | null,
  gankerIntel: GankerIntel[],
  _monitor: {
    routeSystems: number[];
    originId: number;
    destinationId: number;
    currentSystemId: number;
  },
): string {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const tz =
    utcHour >= 17 && utcHour < 24 ? 'EU prime'
    : utcHour >= 0 && utcHour < 6 ? 'US prime'
    : utcHour >= 8 && utcHour < 12 ? 'AU prime'
    : 'off-peak';
  const currentSystem = getCurrentSystemDigest(digest);
  const aheadSystems = selectRelevantAheadSystems(digest);
  const behindSystems = selectRelevantBehindSystems(digest, pursuit);
  const relevantGankers = selectRelevantGankers(digest, gankerIntel);

  const lines: string[] = [
    '=== КОРАБЛЬ ===',
    `${ship.shipName} (класс: ${ship.shipClass})`,
    `EHP: ${ship.ehp}, align: ${ship.alignTime}s, warp: ${ship.warpSpeed} AU/s`,
    `Цель для ганка: ${ship.isHighValueTarget ? 'ДА' : 'нет'}`,
    `Выживаемость: ${ship.survivalChance}`,
    '',
    '=== МАРШРУТ ===',
    `Маршрут: ${digest.origin} → ${digest.destination}`,
    `Позиция: ${digest.pilotSystem} (${digest.pilotSystemIdx + 1}/${digest.totalRouteSystems})`,
    `Осталось прыжков: ${digest.totalRouteSystems - 1 - digest.pilotSystemIdx}`,
    `Общая угроза: ${digest.overallThreat}`,
    '',
  ];

  if (currentSystem && isSystemMeaningful(currentSystem, true)) {
    lines.push('=== ТЕКУЩАЯ СИСТЕМА ===');
    lines.push(formatSystemLine(currentSystem));
    lines.push('');
  }

  if (aheadSystems.length > 0) {
    lines.push('=== ВПЕРЕДИ ===');
    for (const sys of aheadSystems) {
      lines.push(formatSystemLine(sys));
    }
    lines.push('');
  } else {
    lines.push('=== ВПЕРЕДИ ===');
    lines.push('  тихо');
    lines.push('');
  }

  if (behindSystems.length > 0) {
    lines.push('=== СИСТЕМЫ ПОЗАДИ ===');
    for (const sys of behindSystems) {
      lines.push(formatSystemLine(sys));
    }
    lines.push('');
  }

  if (relevantGankers.length > 0) {
    lines.push('=== ИЗВЕСТНЫЕ ГАНКЕРЫ (последние 30 мин) ===');
    for (const g of relevantGankers.slice(0, 5)) {
      const systemParts = g.systems.map((s) => {
        const minsAgo = Math.round((Date.now() - new Date(s.lastSeen).getTime()) / 60_000);
        return `${s.systemName} ${minsAgo} мин назад (${s.killCount} kills)`;
      });
      const movingTag = g.isMoving ? ' ⚠️ ДВИЖЕТСЯ' : '';
      lines.push(`${g.characterName} (${g.shipName}) — ${systemParts.join(', ')}${movingTag}`);
    }
    lines.push('');
  }

  if (pursuit) {
    lines.push('=== ПРЕСЛЕДОВАНИЕ ===');
    lines.push(`Обнаружено! Уверенность: ${pursuit.confidence}`);
    lines.push(`Килы в ${pursuit.systemIds.length} системах позади, приближаются к пилоту.`);
    lines.push(`Окно: ${pursuit.windowMinutes} мин`);
    lines.push('');
  }

  lines.push(`Время: ${now.toISOString()} (${tz})`);

  return lines.join('\n');
}

function getCurrentSystemDigest(digest: RouteThreatDigest): SystemThreatDigest | null {
  return digest.systemsAhead.find((sys) => sys.jumpsFromPilot === 0) ?? null;
}

function isSystemMeaningful(sys: SystemThreatDigest, includeCurrent = false): boolean {
  if (sys.threatLevel === 'MEDIUM') return true;
  if (ACTIONABLE_LEVELS.has(sys.threatLevel)) return true;
  if (sys.gankerCount > 0) return true;
  if (sys.gateKills.some((gate) => gate.recentKills > 0 || gate.killCount >= 2)) return true;
  if (sys.jumpSpike && sys.jumpSpike.severity !== 'elevated') return true;
  if (includeCurrent) return sys.recentKills.length > 0;
  return false;
}

function selectRelevantAheadSystems(digest: RouteThreatDigest): SystemThreatDigest[] {
  return digest.systemsAhead
    .filter((sys) => sys.jumpsFromPilot > 0 && isSystemMeaningful(sys))
    .sort((a, b) => {
      if (a.jumpsFromPilot !== b.jumpsFromPilot) return a.jumpsFromPilot - b.jumpsFromPilot;
      return threatWeight(b.threatLevel) - threatWeight(a.threatLevel);
    })
    .slice(0, 3);
}

function selectRelevantBehindSystems(
  digest: RouteThreatDigest,
  pursuit: PursuitSignal | null,
): SystemThreatDigest[] {
  const pursuitSystems = new Set(pursuit?.systemIds ?? []);
  return digest.systemsBehind
    .filter((sys) => isSystemMeaningful(sys) || pursuitSystems.has(sys.systemId))
    .sort((a, b) => {
      if (Math.abs(a.jumpsFromPilot) !== Math.abs(b.jumpsFromPilot)) {
        return Math.abs(a.jumpsFromPilot) - Math.abs(b.jumpsFromPilot);
      }
      return threatWeight(b.threatLevel) - threatWeight(a.threatLevel);
    })
    .slice(0, 2);
}

function selectRelevantGankers(
  digest: RouteThreatDigest,
  gankerIntel: GankerIntel[],
): GankerIntel[] {
  const jumpMap = buildSystemJumpMap(digest);

  return gankerIntel
    .map((ganker) => ({
      ganker,
      nearestAheadJump: ganker.systems
        .map((system) => jumpMap.get(system.systemId))
        .filter((jump): jump is number => typeof jump === 'number' && jump >= 0)
        .sort((a, b) => a - b)[0] ?? null,
    }))
    .filter(({ ganker, nearestAheadJump }) =>
      nearestAheadJump !== null
      && (ganker.isMoving || ganker.lastSeenMinutesAgo <= 10 || ganker.totalKills >= 3),
    )
    .sort((left, right) => {
      if (left.nearestAheadJump !== right.nearestAheadJump) {
        return (left.nearestAheadJump ?? Infinity) - (right.nearestAheadJump ?? Infinity);
      }
      return left.ganker.lastSeenMinutesAgo - right.ganker.lastSeenMinutesAgo;
    })
    .map(({ ganker }) => ganker);
}

function buildSystemJumpMap(digest: RouteThreatDigest): Map<number, number> {
  const map = new Map<number, number>();
  for (const sys of digest.systemsAhead) map.set(sys.systemId, sys.jumpsFromPilot);
  for (const sys of digest.systemsBehind) map.set(sys.systemId, sys.jumpsFromPilot);
  return map;
}

function threatWeight(level: ThreatLevel): number {
  switch (level) {
    case 'CRITICAL': return 3;
    case 'HIGH': return 2;
    case 'MEDIUM': return 1;
    case 'LOW': return 0;
  }
}

export function shouldUseLlmIntel(
  digest: RouteThreatDigest,
  pursuit: PursuitSignal | null,
  gankerIntel: GankerIntel[],
): boolean {
  if (pursuit?.confidence === 'high') return true;

  const currentSystem = getCurrentSystemDigest(digest);
  if (currentSystem && (currentSystem.threatLevel === 'HIGH' || currentSystem.threatLevel === 'CRITICAL')) {
    return true;
  }
  if (currentSystem && currentSystem.gateKills.some((gate) => gate.recentKills > 0 || gate.killCount >= 2)) {
    return true;
  }

  const aheadSystems = selectRelevantAheadSystems(digest);
  if (aheadSystems.some((system) => system.jumpsFromPilot <= 2 && ACTIONABLE_LEVELS.has(system.threatLevel))) {
    return true;
  }
  if (aheadSystems.some((system) =>
    system.jumpsFromPilot <= 2 && system.gateKills.some((gate) => gate.recentKills > 0 || gate.killCount >= 2),
  )) {
    return true;
  }
  if (aheadSystems.filter((system) => system.jumpsFromPilot <= 3).length >= 2) {
    return true;
  }

  const relevantGankers = selectRelevantGankers(digest, gankerIntel);
  if (relevantGankers.some((ganker) => ganker.isMoving)) return true;

  return false;
}

function formatSystemLine(sys: SystemThreatDigest): string {
  const lines: string[] = [];
  const header = [
    `  ${sys.systemName} (${sys.systemSec.toFixed(1)})`,
    `${Math.abs(sys.jumpsFromPilot)}j`,
    sys.threatLevel,
  ];
  if (sys.reason) header.push(sys.reason);
  if (sys.jumpSpike) header.push(`traffic spike: ${sys.jumpSpike.severity} (+${sys.jumpSpike.delta})`);
  if (sys.gateKills.length > 0) {
    const gk = sys.gateKills.map((g) => `gate ${g.connectedSystemName}: ${g.recentKills} kills`).join(', ');
    header.push(gk);
  }
  if (sys.gankerCount > 0) header.push(`${sys.gankerCount} known gankers`);
  lines.push(header.join(' | '));

  // Add concrete kill details for LLM analysis
  for (const k of sys.recentKills) {
    const soloTag = k.solo ? ' [solo]' : '';
    const atkInfo = k.attackerCount > 1
      ? `${k.attackerCount} atk, FB: ${k.attackerName} (${k.attackerShip})`
      : `${k.attackerName} (${k.attackerShip})`;
    lines.push(`    ${k.time} ${k.victimShip} ${k.valueMISK}M — killed by ${atkInfo}${soloTag}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM response parser
// ---------------------------------------------------------------------------

const REC_MAP: Record<string, RouteIntelSummary['recommendation']> = {
  'СТОП': 'STOP',
  'ЖДАТЬ': 'WAIT',
  'ВПЕРЁД': 'PROCEED',
  'ОБХОД': 'REROUTE',
};

function parseIntelResponse(
  text: string,
  pursuit: PursuitSignal | null,
): RouteIntelSummary | null {
  const recMatch = text.match(/РЕКОМЕНДАЦИЯ:\s*(СТОП|ЖДАТЬ|ВПЕРЁД|ОБХОД)/i);
  const adviceMatch = text.match(/СОВЕТ:\s*(.+?)(?=ФАКТОРЫ:|$)/is);
  const factorsMatch = text.match(/ФАКТОРЫ:\s*(.+)/i);

  if (!recMatch) return null;

  const recommendation = REC_MAP[recMatch[1].toUpperCase()] ?? 'PROCEED';
  const advice = adviceMatch ? adviceMatch[1].trim() : text;
  const factors = factorsMatch
    ? factorsMatch[1].split(',').map((f) => f.trim()).filter(Boolean)
    : [];

  // Extract alternative route hint for REROUTE
  let alternativeVia: string | undefined;
  if (recommendation === 'REROUTE') {
    const viaMatch = advice.match(/(?:через|via)\s+(\S+)/i);
    if (viaMatch) alternativeVia = viaMatch[1];
  }

  return {
    timestamp: new Date().toISOString(),
    recommendation,
    advice,
    alternativeVia,
    factors,
    pursuit,
  };
}

// ---------------------------------------------------------------------------
// 3. Template fallback (no LLM)
// ---------------------------------------------------------------------------

function buildTemplateSummary(
  digest: RouteThreatDigest,
  pursuit: PursuitSignal | null,
  gankerIntel: GankerIntel[],
): RouteIntelSummary {
  const currentSystem = getCurrentSystemDigest(digest);
  const aheadThreats = selectRelevantAheadSystems(digest);
  const nearestAhead = aheadThreats[0] ?? null;
  const relevantGankers = selectRelevantGankers(digest, gankerIntel);
  let recommendation: RouteIntelSummary['recommendation'];
  const factors: string[] = [];

  if (currentSystem?.threatLevel === 'CRITICAL' || pursuit?.confidence === 'high') {
    recommendation = 'STOP';
  } else if (
    currentSystem?.threatLevel === 'HIGH'
    || nearestAhead?.threatLevel === 'CRITICAL'
    || nearestAhead?.threatLevel === 'HIGH'
  ) {
    recommendation = 'WAIT';
  } else {
    recommendation = 'PROCEED';
  }

  const advice = [
    buildCurrentLine(digest, currentSystem, relevantGankers),
    buildAheadLine(digest, relevantGankers),
    buildActionLine(recommendation, nearestAhead !== null || relevantGankers.length > 0),
  ].join('\n');

  if (pursuit) {
    factors.push(`преследование (${pursuit.confidence})`);
  }
  if (currentSystem && isSystemMeaningful(currentSystem, true)) {
    factors.push(`текущая система: ${currentSystem.systemName}`);
  }
  if (nearestAhead) {
    factors.push(`впереди: ${nearestAhead.systemName}`);
  }
  if (relevantGankers.length > 0) {
    factors.push(`активные ганкеры: ${relevantGankers.length}`);
  }
  if (digest.overallThreat !== 'LOW') {
    factors.push(`общий уровень: ${digest.overallThreat}`);
  }
  if (factors.length === 0) {
    factors.push('тихий маршрут');
  }

  return {
    timestamp: new Date().toISOString(),
    recommendation,
    advice,
    factors,
    pursuit,
  };
}

function normaliseReason(reason: string): string {
  return reason.trim().replace(/\.$/, '');
}

function buildSystemOperationalReason(sys: SystemThreatDigest): string {
  if (sys.gateKills.length > 0) {
    const gate = sys.gateKills[0]!;
    const recentPart = gate.recentKills > 0
      ? `${gate.recentKills} свежих киллов`
      : `${gate.killCount} киллов`;
    return `активность у гейта на ${gate.connectedSystemName}: ${recentPart}`;
  }
  return normaliseReason(sys.reason);
}

function buildCurrentLine(
  digest: RouteThreatDigest,
  currentSystem: SystemThreatDigest | null,
  relevantGankers: GankerIntel[],
): string {
  if (!currentSystem) {
    return `Сейчас: ${digest.pilotSystem} — позиция определена, локальных сигналов нет.`;
  }

  if (currentSystem.threatLevel !== 'LOW') {
    return `Сейчас: ${currentSystem.systemName} — ${currentSystem.reason}.`;
  }

  if (currentSystem.gateKills.length > 0) {
    return `Сейчас: ${currentSystem.systemName} — ${buildSystemOperationalReason(currentSystem)}.`;
  }

  const localGankers = relevantGankers.filter((ganker) =>
    ganker.systems.some((system) => system.systemId === currentSystem.systemId),
  );
  if (localGankers.length > 0) {
    return `Сейчас: ${currentSystem.systemName} — локально светились активные пилоты, но без подтверждённого свежего кемпа.`;
  }

  if (currentSystem.recentKills.length > 0) {
    return `Сейчас: ${currentSystem.systemName} — ${normaliseReason(currentSystem.reason)}, активного лагеря не видно.`;
  }

  return `Сейчас: ${currentSystem.systemName} — локально тихо.`;
}

function buildAheadLine(
  digest: RouteThreatDigest,
  relevantGankers: GankerIntel[],
): string {
  const aheadThreats = selectRelevantAheadSystems(digest).slice(0, 2);
  if (aheadThreats.length > 0) {
    const parts = aheadThreats.map((system) =>
      `${system.systemName} через ${formatJumpDistance(Math.abs(system.jumpsFromPilot))} — ${buildSystemOperationalReason(system)}`,
    );
    return `Впереди: ${parts.join('; ')}.`;
  }

  if (relevantGankers.length > 0) {
    const named = relevantGankers.slice(0, 2).map((ganker) => ganker.characterName).filter(Boolean);
    const suffix = named.length > 0 ? ` Видны пилоты: ${named.join(', ')}.` : '';
    return `Впереди: свежих PvP-паттернов не видно, но на трассе есть активные ганкеры.${suffix}`;
  }

  const nextSystems = digest.systemsAhead
    .filter((system) => system.jumpsFromPilot > 0)
    .sort((left, right) => left.jumpsFromPilot - right.jumpsFromPilot)
    .slice(0, 4)
    .map((system) => system.systemName);

  if (nextSystems.length === 0) {
    return 'Впереди: маршрут почти завершён, свежих PvP-угроз не видно.';
  }

  return `Впереди: ${nextSystems.join(', ')} — свежих PvP-угроз не видно.`;
}

function formatJumpDistance(jumps: number): string {
  const mod10 = jumps % 10;
  const mod100 = jumps % 100;
  if (mod10 === 1 && mod100 !== 11) return `${jumps} прыжок`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${jumps} прыжка`;
  return `${jumps} прыжков`;
}

function buildActionLine(
  recommendation: RouteIntelSummary['recommendation'],
  hasAnyRisk: boolean,
): string {
  switch (recommendation) {
    case 'STOP':
      return 'Действие: не выходите дальше, док/переварп и переждите.';
    case 'WAIT':
      return 'Действие: подождите 10-15 минут или проверьте трассу скаутом перед выходом.';
    case 'REROUTE':
      return 'Действие: меняйте маршрут, текущая трасса даёт слишком плохое окно.';
    case 'PROCEED':
      return hasAnyRisk
        ? 'Действие: можно идти, но не стойте на воротах и не полагайтесь на автопилот.'
        : 'Действие: можно выходить, держите нормальную дисциплину на андоке и воротах.';
  }
}

// ---------------------------------------------------------------------------
// 4. Format intelligence message for Telegram
// ---------------------------------------------------------------------------

const REC_EMOJI: Record<RouteIntelSummary['recommendation'], string> = {
  STOP: '\u{1F534}',     // red circle
  WAIT: '\u{1F7E1}',     // yellow circle
  PROCEED: '\u{1F7E2}',  // green circle
  REROUTE: '\u{1F7E0}',  // orange circle
};

const REC_LABEL: Record<RouteIntelSummary['recommendation'], string> = {
  STOP: 'СТОП',
  WAIT: 'ЖДАТЬ',
  PROCEED: 'ВПЕРЁД',
  REROUTE: 'ОБХОД',
};

export function formatIntelMessage(
  summary: RouteIntelSummary,
  context?: {
    digest?: RouteThreatDigest;
    ship?: ShipAssessment;
    gankerIntel?: GankerIntel[];
  },
): string {
  const emoji = REC_EMOJI[summary.recommendation];
  const label = REC_LABEL[summary.recommendation];
  const now = new Date();
  const timeStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;
  const adviceLines = buildOperationalAdviceLines(summary, context);

  const lines: string[] = [
    `\u{1F6F0}\u{FE0F} ESP | ${emoji} ${label}`,
    '',
    ...adviceLines,
  ];

  if (summary.pursuit) {
    lines.push('');
    lines.push(
      `\u{1F6A8} Преследование: ${summary.pursuit.confidence}, ${summary.pursuit.systemIds.length} систем`,
    );
  }

  lines.push('');
  lines.push(`${timeStr}`);

  return lines.join('\n');
}

function buildOperationalAdviceLines(
  summary: RouteIntelSummary,
  context?: {
    digest?: RouteThreatDigest;
    ship?: ShipAssessment;
    gankerIntel?: GankerIntel[];
  },
): string[] {
  const fromAdvice = extractOperationalLines(summary.advice);
  if (fromAdvice.length >= 3) {
    return fromAdvice.slice(0, 3);
  }

  if (context?.digest) {
    return buildFallbackOperationalLines(summary, context.digest, context.gankerIntel ?? []);
  }

  const compact = summary.advice
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (compact.length >= 3) {
    return compact.slice(0, 3);
  }

  return [
    'Сейчас: сводка сокращена.',
    'Впереди: ориентируйтесь на последний скан маршрута.',
    `Действие: ${buildActionLine(summary.recommendation, true).replace(/^Действие:\s*/, '')}`,
  ];
}

function extractOperationalLines(advice: string): string[] {
  const lines = advice
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const labeled = lines.filter((line) =>
    line.startsWith('Сейчас:') || line.startsWith('Впереди:') || line.startsWith('Действие:'),
  );
  if (labeled.length >= 3) return labeled;

  const current = extractAdviceLine(advice, 'Сейчас');
  const ahead = extractAdviceLine(advice, 'Впереди');
  const action = extractAdviceLine(advice, 'Действие');
  const extracted = [current, ahead, action].filter((line): line is string => Boolean(line));
  return extracted;
}

function extractAdviceLine(advice: string, label: 'Сейчас' | 'Впереди' | 'Действие'): string | null {
  const match = advice.match(new RegExp(`${label}:\\s*([^\\n]+)`, 'i'));
  if (!match?.[1]) return null;
  return `${label}: ${match[1].trim()}`;
}

function buildFallbackOperationalLines(
  summary: RouteIntelSummary,
  digest: RouteThreatDigest,
  gankerIntel: GankerIntel[],
): string[] {
  const currentSystem = getCurrentSystemDigest(digest);
  const hasAheadRisk = selectRelevantAheadSystems(digest).length > 0;
  const relevantGankers = selectRelevantGankers(digest, gankerIntel);

  return [
    buildCurrentLine(digest, currentSystem, relevantGankers),
    buildAheadLine(digest, relevantGankers),
    buildActionLine(summary.recommendation, hasAheadRisk || relevantGankers.length > 0),
  ];
}
