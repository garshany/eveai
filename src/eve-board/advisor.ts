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
  'Ты получаешь полные данные о маршруте: киллы, трафик, ганкеры, угрозы.',
  'Проанализируй ВСЮ информацию и дай пилоту полную картину.',
  '',
  'Формат ответа (строго):',
  'РЕКОМЕНДАЦИЯ: СТОП|ЖДАТЬ|ВПЕРЁД|ОБХОД',
  'СОВЕТ: 3-6 строк конкретного анализа. Назови конкретные системы, корабли, имена.',
  'Если тихо — скажи что безопасно и почему. Если есть киллы — проанализируй кто кого убил,',
  'насколько опасен атакующий для нашего корабля, есть ли паттерн (ганк-флот, gate camp, соло).',
  'ФАКТОРЫ: ключевые факторы через запятую',
].join('\n');

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

  return buildTemplateSummary(digest, pursuit);
}

// ---------------------------------------------------------------------------
// Intel prompt builder
// ---------------------------------------------------------------------------

function buildIntelPrompt(
  digest: RouteThreatDigest,
  ship: ShipAssessment,
  pursuit: PursuitSignal | null,
  gankerIntel: GankerIntel[],
  monitor: {
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

  const lines: string[] = [
    '=== КОРАБЛЬ ===',
    `${ship.shipName} (класс: ${ship.shipClass})`,
    `EHP: ${ship.ehp}, align: ${ship.alignTime}s, warp: ${ship.warpSpeed} AU/s`,
    `Цель для ганка: ${ship.isHighValueTarget ? 'ДА' : 'нет'}`,
    `Выживаемость: ${ship.survivalChance}`,
    '',
    '=== МАРШРУТ ===',
    `Позиция: ${digest.pilotSystem} (${digest.pilotSystemIdx + 1}/${monitor.routeSystems.length})`,
    `Всего прыжков: ${monitor.routeSystems.length - 1}`,
    `Общая угроза: ${digest.overallThreat}`,
    '',
  ];

  if (digest.systemsAhead.length > 0) {
    lines.push('=== СИСТЕМЫ ВПЕРЕДИ ===');
    for (const sys of digest.systemsAhead) {
      lines.push(formatSystemLine(sys));
    }
    lines.push('');
  }

  if (digest.systemsBehind.length > 0) {
    lines.push('=== СИСТЕМЫ ПОЗАДИ ===');
    for (const sys of digest.systemsBehind) {
      lines.push(formatSystemLine(sys));
    }
    lines.push('');
  }

  if (gankerIntel.length > 0) {
    lines.push('=== ИЗВЕСТНЫЕ ГАНКЕРЫ (последние 30 мин) ===');
    for (const g of gankerIntel.slice(0, 10)) {
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
): RouteIntelSummary {
  const hasCritical = digest.systemsAhead.some((s) => s.threatLevel === 'CRITICAL');
  const highCount = digest.systemsAhead.filter((s) => s.threatLevel === 'HIGH').length;
  const mostAhead = digest.systemsAhead.length;

  let recommendation: RouteIntelSummary['recommendation'];
  let advice: string;
  const factors: string[] = [];

  if (hasCritical && pursuit) {
    recommendation = 'STOP';
    advice = 'Впереди критическая угроза, обнаружено преследование. Задокьтесь немедленно.';
    factors.push('критическая угроза', 'преследование');
  } else if (hasCritical) {
    recommendation = 'WAIT';
    const critSys = digest.systemsAhead.find((s) => s.threatLevel === 'CRITICAL');
    advice = critSys
      ? `Критическая угроза в ${critSys.systemName} (${Math.abs(critSys.jumpsFromPilot)} прыжков впереди). Подождите 15-20 минут.`
      : 'Критическая угроза на маршруте. Подождите 15-20 минут.';
    factors.push('критическая угроза');
  } else if (pursuit?.confidence === 'high') {
    recommendation = 'STOP';
    advice = 'Высокая вероятность преследования. Задокьтесь и подождите.';
    factors.push('преследование высокой уверенности');
  } else if (mostAhead > 0 && highCount >= mostAhead * 0.5) {
    recommendation = 'WAIT';
    advice = `Большинство систем впереди (${highCount}/${mostAhead}) на высоком уровне угрозы. Подождите.`;
    factors.push('множественные HIGH системы');
  } else {
    recommendation = 'PROCEED';
    advice = 'Маршрут относительно безопасен. Будьте внимательны.';
    factors.push('низкая угроза');
  }

  if (pursuit && !factors.includes('преследование') && !factors.includes('преследование высокой уверенности')) {
    factors.push(`преследование (${pursuit.confidence})`);
  }
  if (digest.overallThreat !== 'LOW') {
    factors.push(`общий уровень: ${digest.overallThreat}`);
  }

  return {
    timestamp: new Date().toISOString(),
    recommendation,
    advice,
    factors,
    pursuit,
  };
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

export function formatIntelMessage(summary: RouteIntelSummary): string {
  const emoji = REC_EMOJI[summary.recommendation];
  const label = REC_LABEL[summary.recommendation];
  const now = new Date();
  const timeStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;

  const lines: string[] = [
    `\u{1F6F0}\u{FE0F} ESP | ${emoji} ${label}`,
    '',
    summary.advice,
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
