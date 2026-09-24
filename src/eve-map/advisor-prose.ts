/**
 * Perimeter situation assessment — the part of the radar that *understands*.
 *
 * Rules already fired a complete, deterministic sentence (see advisor.ts); this
 * module is the follow-up a human intel officer would give: what the combined
 * picture means for this pilot in this hull, and what to do next. It runs only
 * behind `shouldEscalateToModel` (danger-level rule + its own long cooldown),
 * never blocks the stream, and answers null on any failure so the rule text
 * stands alone.
 *
 * The prompt carries facts only: the bubble (public killmail intel), the
 * pilot's own position and hull, and the active route. No tokens, no account
 * data, and the model is told not to invent anything that is not listed.
 */

import { config } from '../config.js';
import { createNativeResponse, toNativeMessage, type NativeUsage } from '../agent/native-responses.js';
import type { Advisory } from './advisor.js';
import type { BubblePayload, BubbleSystem } from './bubble.js';

export type SituationInput = {
  advisories: Advisory[];
  bubble: BubblePayload;
  currentSystemId: number;
  routeAhead: number[];
  locale: 'ru' | 'en';
  now: number;
  signal?: AbortSignal;
  /** Spend accounting: the call is billed like any other model call. */
  onUsage?: (usage: NativeUsage) => void;
};

const ASSESSMENT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 700;
const MAX_ASSESSMENT_CHARS = 700;
const TOP_DANGER_SYSTEMS = 6;
const RECENT_KILLS = 8;

const INSTRUCTIONS: Record<'ru' | 'en', string> = {
  ru: [
    'Ты — офицер разведки на мостике корабля пилота EVE Online. Радар только что поднял тревогу.',
    'По фактам ниже дай оценку обстановки: 2–4 коротких предложения на русском.',
    'Сначала что происходит и насколько это опасно именно для этого корабля, затем одно конкретное действие',
    '(оставаться в доке/на месте, свернуть через конкретную систему, лететь дальше, выровняться на гейт и т.п.).',
    'Используй только перечисленные факты и названия. Ничего не выдумывай: ни пилотов, ни систем, ни чисел.',
    'Не повторяй дословно тексты тревог. Без приветствий, без markdown-заголовков.',
  ].join('\n'),
  en: [
    'You are the intelligence officer on the bridge of an EVE Online pilot. The radar just raised an alarm.',
    'From the facts below give a situation assessment: 2–4 short sentences in English.',
    'First what is happening and how dangerous it is for this particular hull, then one concrete action',
    '(stay docked/put, divert via a named system, continue, align to a gate, etc.).',
    'Use only the listed facts and names. Invent nothing: no pilots, systems or numbers.',
    'Do not repeat the alarm texts verbatim. No greetings, no markdown headings.',
  ].join('\n'),
};

/** Danger scores are 0..1. */
function percent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

/** Build the fact sheet the model reasons over. Exported for tests. */
export function buildSituationFacts(input: SituationInput): string {
  const { bubble, currentSystemId, routeAhead, advisories, locale, now } = input;
  const byId = new Map<number, BubbleSystem>(bubble.systems.map((system) => [system.systemId, system]));
  const here = byId.get(currentSystemId);
  const nameOf = (systemId: number | null): string => {
    if (systemId === null) return '?';
    return byId.get(systemId)?.name ?? String(systemId);
  };
  const lines: string[] = [];

  lines.push(`Pilot position: ${here ? `${here.name} (sec ${here.security.toFixed(1)}${here.regionName ? `, ${here.regionName}` : ''})` : currentSystemId}`);
  if (bubble.pilotShip) {
    const ship = bubble.pilotShip;
    lines.push(`Pilot hull: ${ship.shipName} (${ship.shipClass}, EHP ${Math.round(ship.ehp)}, align ${ship.alignTime}s, survival: ${ship.survivalChance})`);
  } else {
    lines.push('Pilot hull: unknown');
  }
  lines.push(`Bubble: radius ${bubble.radius} jumps, ${bubble.systems.length} systems, verdict ${bubble.verdict.band} (${percent(bubble.verdict.score)}), worst ${nameOf(bubble.verdict.worstSystemId)}`);

  lines.push('');
  lines.push(`Alarms just raised (${locale}):`);
  for (const advisory of advisories) {
    lines.push(`- [${advisory.severity}/${advisory.rule}] ${advisory.text[locale]}`);
  }

  const dangerous = bubble.systems
    .filter((system) => system.danger.score > 0)
    .sort((left, right) => right.danger.score - left.danger.score)
    .slice(0, TOP_DANGER_SYSTEMS);
  if (dangerous.length > 0) {
    lines.push('');
    lines.push('Most dangerous systems nearby:');
    for (const system of dangerous) {
      const camps = system.gateCamps.length > 0 ? `, gate camp kills ${system.gateCamps.length}` : '';
      lines.push(`- ${system.name}: ${system.jumps} jumps away, sec ${system.security.toFixed(1)}, danger ${system.danger.band} (${percent(system.danger.score)}), kills 15m/1h ${system.activity.kills15m}/${system.activity.kills1h}${camps}`);
    }
  }

  const kills = [...bubble.recentKills]
    .filter((kill) => !kill.isNpc)
    .sort((left, right) => right.killmailTimeMs - left.killmailTimeMs)
    .slice(0, RECENT_KILLS);
  if (kills.length > 0) {
    lines.push('');
    lines.push('Latest player kills in the bubble:');
    for (const kill of kills) {
      const minutes = Math.max(0, Math.round((now - kill.killmailTimeMs) / 60_000));
      const victim = kill.victimShipName ?? 'unknown hull';
      const killer = kill.finalBlowCharacterName
        ? `${kill.finalBlowCharacterName}${kill.finalBlowShipName ? ` in ${kill.finalBlowShipName}` : ''}`
        : 'unknown attacker';
      const where = kill.gateId !== null ? ' on a gate' : '';
      lines.push(`- ${minutes} min ago in ${nameOf(kill.systemId)}${where}: ${victim} killed by ${killer}, ${kill.attackerCount} attackers, ${(kill.totalValue / 1_000_000).toFixed(0)}M ISK`);
    }
  }

  if (routeAhead.length > 0) {
    lines.push('');
    lines.push(`Active route ahead: ${routeAhead.slice(0, 12).map((systemId) => nameOf(systemId)).join(' → ')}${routeAhead.length > 12 ? ' → …' : ''}`);
  }

  return lines.join('\n');
}

/**
 * One short model-written assessment, or null. Never throws: the radar keeps
 * running on rules alone when the model is slow, down, or says nothing.
 */
export async function composeSituationAssessment(input: SituationInput): Promise<string | null> {
  if (input.advisories.length === 0) return null;
  const timeout = AbortSignal.timeout(ASSESSMENT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    const response = await createNativeResponse({
      instructions: INSTRUCTIONS[input.locale],
      items: [toNativeMessage(buildSituationFacts(input))],
      tools: [],
      parallelToolCalls: false,
      reasoningEffort: 'low',
      textVerbosity: 'low',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      model: config.openai.model,
      signal,
    });
    if (response.usage) input.onUsage?.(response.usage);
    if (response.error || (response.status && response.status !== 'completed')) return null;
    return sanitizeAssessment(response.outputText);
  } catch (error) {
    console.warn('[map-advisor] situation assessment failed: %s', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}

/** Trim, drop markdown headings, and cap the length. Exported for tests. */
export function sanitizeAssessment(text: string): string | null {
  const cleaned = text
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= MAX_ASSESSMENT_CHARS) return cleaned;
  const cut = cleaned.slice(0, MAX_ASSESSMENT_CHARS);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return sentenceEnd > MAX_ASSESSMENT_CHARS / 2 ? cut.slice(0, sentenceEnd + 1) : `${cut.trimEnd()}…`;
}
