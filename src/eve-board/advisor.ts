/**
 * Route advisor — LLM-powered threat advice for HIGH/CRITICAL threat levels.
 *
 * Sends a compact context to the model and returns personalized Russian-language
 * advice (3-5 lines). Falls back to a template-based alert when the LLM is
 * unavailable or too slow.
 */

import type { Db } from '../db/sqlite.js';
import type { KillPattern, ShipAssessment, ThreatLevel } from './types.js';
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
