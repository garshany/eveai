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
import { getKilllist } from '../eve-kill/client.js';
import { assessShip, analyzeKillPattern, scoreThreat, detectGankWindow } from './threat.js';
import type { RouteStats, DangerEvent, ThreatLevel, KillPattern, ShipAssessment } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Systems with sec >= 1.0 are fully safe — skip scanning. */
const SAFE_SEC_THRESHOLD = 1.0;

/** Max systems to scan to keep briefing fast. */
const MAX_SYSTEMS_TO_SCAN = 10;

/** Kills to fetch per system from EVE-KILL. */
const KILLS_PER_SYSTEM = 20;

/** Short TTL for kill queries during briefing (seconds). */
const KILL_CACHE_TTL = 60;

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
// Text helpers
// ---------------------------------------------------------------------------

const THREAT_EMOJI: Record<ThreatLevel, string> = {
  CRITICAL: '\u{1F534}',  // red circle
  HIGH: '\u{1F7E0}',      // orange circle
  MEDIUM: '\u{1F7E1}',    // yellow circle
  LOW: '\u{1F7E2}',       // green circle
};

const THREAT_LABEL: Record<ThreatLevel, string> = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

const SURVIVAL_TEXT: Record<ShipAssessment['survivalChance'], string> = {
  DEAD: '\u{1F480} Не выживет при ганке',
  UNLIKELY: '\u{26A0}\u{FE0F} Маловероятно выживет',
  POSSIBLE: '\u{1F7E1} Есть шанс пережить',
  SAFE: '\u{1F7E2} Высокая живучесть',
};

function formatKillRate(killCount: number, windowMinutes: number): string {
  if (windowMinutes <= 0) return `${killCount} убийств`;
  if (windowMinutes < 60) return `${killCount} за ${windowMinutes} мин`;
  const perHour = Math.round(killCount / (windowMinutes / 60));
  return `${perHour} ганков/час`;
}

// ---------------------------------------------------------------------------
// 1. generateBriefing
// ---------------------------------------------------------------------------

type DangerSystemInfo = {
  name: string;
  sec: number;
  pattern: KillPattern;
  threatLevel: ThreatLevel;
  threatReason: string;
};

/**
 * Generate a pre-route briefing: danger assessment, ship check, recommendations.
 *
 * Scans systems on route with sec < 1.0 (up to MAX_SYSTEMS_TO_SCAN) for recent
 * kill activity from EVE-KILL, scores threat against the pilot's ship, and
 * compiles a formatted Russian-language briefing string.
 */
export async function generateBriefing(
  db: Db,
  routeSystems: number[],
  originName: string,
  destName: string,
  characterId: number,
  shipTypeId: number,
): Promise<string> {
  // Step 1: assess ship
  const ship = assessShip(db, shipTypeId);

  // Step 2: identify systems to scan (sec < 1.0, up to limit)
  const systemsToScan: Array<{ id: number; name: string; sec: number }> = [];
  for (const sysId of routeSystems) {
    if (systemsToScan.length >= MAX_SYSTEMS_TO_SCAN) break;
    const sec = resolveSystemSec(db, sysId);
    if (sec < SAFE_SEC_THRESHOLD) {
      systemsToScan.push({ id: sysId, name: resolveSystemName(db, sysId), sec });
    }
  }

  // Step 3: fetch kills and analyze patterns in parallel
  const dangerSystems: DangerSystemInfo[] = [];
  const patterns: KillPattern[] = [];

  const scanResults = await Promise.all(
    systemsToScan.map(async (sys) => {
      const killResult = await getKilllist(db, {
        system_id: sys.id,
        limit: KILLS_PER_SYSTEM,
      }, KILL_CACHE_TTL);

      if (!killResult.ok || killResult.data.length === 0) {
        return null;
      }

      const pattern = analyzeKillPattern(killResult.data, sys.id, sys.name, sys.sec);
      const threat = scoreThreat(pattern, ship);
      return { sys, pattern, threat };
    }),
  );

  for (const result of scanResults) {
    if (!result) continue;
    const { sys, pattern, threat } = result;

    patterns.push(pattern);

    // Only include systems with meaningful threat (not LOW)
    if (threat.level !== 'LOW') {
      dangerSystems.push({
        name: sys.name,
        sec: sys.sec,
        pattern,
        threatLevel: threat.level,
        threatReason: threat.reason,
      });
    }
  }

  // Sort danger systems: CRITICAL first, then HIGH, then MEDIUM
  const levelOrder: Record<ThreatLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  dangerSystems.sort((a, b) => levelOrder[a.threatLevel] - levelOrder[b.threatLevel]);

  // Step 4: gank window detection
  const gankWindow = detectGankWindow(patterns);

  // Step 5: format briefing
  return formatBriefing(ship, dangerSystems, gankWindow, originName, destName, routeSystems.length);
}

function formatBriefing(
  ship: ShipAssessment,
  dangerSystems: DangerSystemInfo[],
  gankWindow: { isOpen: boolean; reason: string },
  originName: string,
  destName: string,
  jumps: number,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`\u{1F4CB} \u0411\u0440\u0438\u0444: ${originName} \u2192 ${destName} (${jumps} \u043F\u0440\u044B\u0436\u043A\u043E\u0432)`);
  lines.push('');

  // Ship info
  lines.push(
    `\u{1F680} \u041A\u043E\u0440\u0430\u0431\u043B\u044C: ${ship.shipName} | EHP: ${ship.ehp.toLocaleString('ru-RU')} | Align: ${ship.alignTime}s`,
  );
  lines.push(`\u041E\u0446\u0435\u043D\u043A\u0430: ${SURVIVAL_TEXT[ship.survivalChance]}`);
  lines.push('');

  // Danger systems
  if (dangerSystems.length === 0) {
    lines.push('\u2705 \u041C\u0430\u0440\u0448\u0440\u0443\u0442 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u0435\u043D. \u0413\u0430\u043D\u043A\u043E\u0432\u043E\u0439 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438 \u043D\u0435 \u043E\u0431\u043D\u0430\u0440\u0443\u0436\u0435\u043D\u043E.');
  } else {
    lines.push('\u26A0\uFE0F \u041E\u043F\u0430\u0441\u043D\u044B\u0435 \u0441\u0438\u0441\u0442\u0435\u043C\u044B:');
    for (const ds of dangerSystems) {
      const emoji = THREAT_EMOJI[ds.threatLevel];
      const killInfo = formatKillRate(ds.pattern.killCount, ds.pattern.timeWindowMinutes);
      lines.push(
        `  ${emoji} ${ds.name} (${ds.sec}) \u2014 ${killInfo}, ${THREAT_LABEL[ds.threatLevel]} \u0434\u043B\u044F \u0442\u0435\u0431\u044F`,
      );
    }
    lines.push('');

    // Gank window info (only when there are danger systems)
    if (gankWindow.isOpen) {
      lines.push(`\u{1F7E2} \u041E\u043A\u043D\u043E \u043F\u0440\u043E\u0445\u043E\u0434\u0430: ${gankWindow.reason}`);
    } else {
      lines.push(`\u{1F534} \u041E\u043A\u043D\u043E \u043F\u0440\u043E\u0445\u043E\u0434\u0430: ${gankWindow.reason}`);
    }
  }

  lines.push('');

  // Recommendation
  lines.push(`\u{1F4A1} \u0420\u0435\u043A\u043E\u043C\u0435\u043D\u0434\u0430\u0446\u0438\u044F: ${pickRecommendation(ship, dangerSystems, gankWindow)}`);

  return lines.join('\n');
}

function pickRecommendation(
  ship: ShipAssessment,
  dangerSystems: DangerSystemInfo[],
  gankWindow: { isOpen: boolean; reason: string },
): string {
  const hasCritical = dangerSystems.some(d => d.threatLevel === 'CRITICAL');
  const hasHigh = dangerSystems.some(d => d.threatLevel === 'HIGH');

  if (hasCritical && ship.survivalChance === 'DEAD') {
    return '\u041D\u0435 \u043B\u0435\u0442\u0438\u0442\u0435! \u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u0433\u0430\u043D\u043A-\u0444\u043B\u043E\u0442, \u0432\u0430\u0448 \u043A\u043E\u0440\u0430\u0431\u043B\u044C \u043D\u0435 \u0432\u044B\u0436\u0438\u0432\u0435\u0442. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0430\u043B\u044C\u0442\u0435\u0440\u043D\u0430\u0442\u0438\u0432\u043D\u044B\u0439 \u043C\u0430\u0440\u0448\u0440\u0443\u0442 \u0438\u043B\u0438 \u043F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435.';
  }
  if (hasCritical) {
    return '\u041E\u0447\u0435\u043D\u044C \u043E\u043F\u0430\u0441\u043D\u043E. \u0415\u0441\u043B\u0438 \u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E, \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043E\u0439 \u043C\u0430\u0440\u0448\u0440\u0443\u0442 \u0438\u043B\u0438 \u0434\u043E\u0436\u0434\u0438\u0442\u0435\u0441\u044C \u043E\u043A\u043D\u0430 \u043F\u0440\u043E\u0445\u043E\u0434\u0430.';
  }
  if (hasHigh && !gankWindow.isOpen) {
    return '\u0413\u0430\u043D\u043A\u0435\u0440\u044B \u0430\u043A\u0442\u0438\u0432\u043D\u044B. \u041F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 15\u201320 \u043C\u0438\u043D\u0443\u0442 \u043F\u043E\u0441\u043B\u0435 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0433\u043E \u043A\u0438\u043B\u043B\u0430 \u0438\u043B\u0438 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0441\u043A\u0430\u0443\u0442\u0430.';
  }
  if (hasHigh && gankWindow.isOpen) {
    return '\u0415\u0441\u0442\u044C \u043E\u043A\u043D\u043E \u043F\u0440\u043E\u0445\u043E\u0434\u0430, \u043D\u043E \u0431\u0443\u0434\u044C\u0442\u0435 \u0432\u043D\u0438\u043C\u0430\u0442\u0435\u043B\u044C\u043D\u044B. \u041B\u043E\u043A\u0430\u043B \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0441\u0442\u0440\u043E \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C\u0441\u044F.';
  }
  if (dangerSystems.length > 0) {
    return '\u0423\u043C\u0435\u0440\u0435\u043D\u043D\u044B\u0439 \u0440\u0438\u0441\u043A. \u041B\u0435\u0442\u0438\u0442\u0435 \u0441 \u043E\u0441\u0442\u043E\u0440\u043E\u0436\u043D\u043E\u0441\u0442\u044C\u044E, \u0441\u043B\u0435\u0434\u0438\u0442\u0435 \u0437\u0430 \u043B\u043E\u043A\u0430\u043B\u043E\u043C.';
  }
  return '\u041C\u0430\u0440\u0448\u0440\u0443\u0442 \u0447\u0438\u0441\u0442. \u041B\u0435\u0442\u0438\u0442\u0435 \u0441\u043F\u043E\u043A\u043E\u0439\u043D\u043E.';
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
