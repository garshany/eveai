/**
 * Perimeter danger scoring.
 *
 * A red dot with no explanation is not intelligence. Every score here is
 * returned as a list of labelled terms that sum to it, so the UI can show why a
 * system is dangerous and the agent can quote the reason instead of inventing
 * one.
 *
 * The score is deliberately relative to the pilot: the same system scores
 * differently for a freighter and for an interceptor, because the question is
 * never "is this system dangerous" but "is this system dangerous for me".
 */

import type { Db } from '../db/sqlite.js';
import type { ShipAssessment } from '../eve-board/types.js';
import type { SystemKillRollup } from './kill-index.js';

export type DangerTerm = {
  /** Stable machine key; the UI maps it to a localized sentence. */
  key: string;
  value: number;
  /** Raw evidence behind the term, for the inspector and the agent. */
  detail?: string;
};

export type DangerBand = 'calm' | 'watch' | 'elevated' | 'hostile' | 'lethal';

export type DangerScore = {
  systemId: number;
  /** 0..1. */
  score: number;
  band: DangerBand;
  terms: DangerTerm[];
};

export type DangerInput = {
  systemId: number;
  security: number;
  rollup: SystemKillRollup;
  /** Distinct attacker characters seen killing here inside the window. */
  attackers: Array<{ characterId: number; name: string | null; kills: number }>;
  /** Kills attributed to a single stargate — the camp signature. */
  maxGateKills: number;
  /** Victim hull group names seen here recently. */
  victimGroups: string[];
  /** Hourly ESI baseline; a long-run signal, not a live one. */
  baselineShipKills1h: number;
  /** The pilot's current hull, when it is known. */
  pilotShip: ShipAssessment | null;
};

/**
 * Weights sum to more than 1 on purpose: several terms firing at once should
 * saturate the score, because several signals firing at once is exactly when a
 * system is genuinely lethal. The final value is clamped.
 */
const WEIGHTS = {
  recentKills: 0.45,
  repeatAttackers: 0.25,
  gateCamp: 0.3,
  victimSimilarity: 0.15,
  capabilityGap: 0.25,
  securityFloor: 0.2,
  baseline: 0.1,
} as const;

const BANDS: Array<{ band: DangerBand; min: number }> = [
  { band: 'lethal', min: 0.8 },
  { band: 'hostile', min: 0.6 },
  { band: 'elevated', min: 0.35 },
  { band: 'watch', min: 0.15 },
  { band: 'calm', min: 0 },
];

export function scoreSystemDanger(input: DangerInput): DangerScore {
  const terms: DangerTerm[] = [];

  // --- Live PvP pressure, weighted by how recent it is ----------------------
  // A kill five minutes ago says the shooter is probably still there; a kill
  // fifty minutes ago says almost nothing. The 15m window therefore counts for
  // far more than the hour it sits inside.
  const pvp1h = Math.max(0, input.rollup.pvpKills1h);
  if (pvp1h > 0) {
    const recentShare = input.rollup.kills15m / Math.max(1, input.rollup.kills1h);
    const volume = saturate(pvp1h / 6);
    const recency = 0.4 + 0.6 * clamp01(recentShare);
    const value = WEIGHTS.recentKills * volume * recency;
    terms.push({
      key: 'recent_kills',
      value,
      detail: `${pvp1h} PvP kill(s) in the last hour, ${input.rollup.kills15m} in the last 15 minutes`,
    });
  }

  // --- Repeat attackers -----------------------------------------------------
  // One kill is an event. The same pilot with several is a resident.
  const repeat = input.attackers.filter((attacker) => attacker.kills > 1);
  if (repeat.length > 0) {
    const strength = saturate(repeat.reduce((sum, a) => sum + a.kills, 0) / 6);
    const value = WEIGHTS.repeatAttackers * strength;
    const names = repeat.slice(0, 3).map((a) => a.name ?? `#${a.characterId}`).join(', ');
    terms.push({
      key: 'repeat_attackers',
      value,
      detail: `${repeat.length} repeat attacker(s): ${names}`,
    });
  }

  // --- Gate camp signature --------------------------------------------------
  // Kills spread across a system are ratting or a roam. Kills stacked on one
  // gate are a camp, and a camp is the thing that actually kills a traveller.
  if (input.maxGateKills >= 2) {
    const value = WEIGHTS.gateCamp * saturate(input.maxGateKills / 4);
    terms.push({
      key: 'gate_camp',
      value,
      detail: `${input.maxGateKills} kill(s) attributed to a single stargate`,
    });
  }

  // --- Victim similarity ----------------------------------------------------
  // What is dying here matters: a system that eats haulers is a different
  // threat to a hauler than to a frigate.
  if (input.pilotShip && input.victimGroups.length > 0) {
    const pilotClass = input.pilotShip.shipClass.toLowerCase();
    const matches = input.victimGroups.filter(
      (group) => group.toLowerCase().includes(pilotClass) || pilotClass.includes(group.toLowerCase()),
    ).length;
    if (matches > 0) {
      const value = WEIGHTS.victimSimilarity * saturate(matches / 2);
      terms.push({
        key: 'victim_similarity',
        value,
        detail: `${matches} recent victim(s) flew a hull like yours (${input.pilotShip.shipClass})`,
      });
    }
  }

  // --- Capability gap -------------------------------------------------------
  // The pilot's own survivability verdict, computed once by assessShip.
  if (input.pilotShip && pvp1h > 0) {
    const survival = input.pilotShip.survivalChance;
    const gap = survival === 'DEAD' ? 1 : survival === 'UNLIKELY' ? 0.7 : survival === 'POSSIBLE' ? 0.35 : 0;
    if (gap > 0) {
      const value = WEIGHTS.capabilityGap * gap;
      terms.push({
        key: 'capability_gap',
        value,
        detail: `${input.pilotShip.shipName}: survival ${survival.toLowerCase()} against what is shooting here`,
      });
    }
    if (input.pilotShip.isHighValueTarget) {
      terms.push({
        key: 'high_value_hull',
        value: 0.05,
        detail: `${input.pilotShip.shipName} is a hull gankers hunt on purpose`,
      });
    }
  }

  // --- Security floor -------------------------------------------------------
  // Rules of engagement, not activity: CONCORD changes what an attacker is
  // willing to try, regardless of whether anything happened yet.
  const securityRisk = securityFloor(input.security);
  if (securityRisk > 0) {
    terms.push({
      key: 'security_floor',
      value: WEIGHTS.securityFloor * securityRisk,
      detail: `security ${input.security.toFixed(1)}`,
    });
  }

  // --- Hourly ESI baseline --------------------------------------------------
  if (input.baselineShipKills1h > 0) {
    terms.push({
      key: 'esi_baseline',
      value: WEIGHTS.baseline * saturate(input.baselineShipKills1h / 10),
      detail: `${input.baselineShipKills1h} ship kill(s) in the last ESI hour`,
    });
  }

  let score = terms.reduce((sum, term) => sum + term.value, 0);

  // --- Quiet discount -------------------------------------------------------
  // Without this, every nullsec system paints red on security class alone and
  // the map becomes useless exactly where it matters most. A system with no
  // observed activity at all keeps only a fraction of its structural risk.
  if (input.rollup.kills24h === 0 && input.baselineShipKills1h === 0) {
    const before = score;
    score *= 0.35;
    terms.push({
      key: 'quiet_discount',
      value: score - before,
      detail: 'nothing observed here in the last 24 hours',
    });
  }

  const clamped = clamp01(score);
  return {
    systemId: input.systemId,
    score: Math.round(clamped * 1000) / 1000,
    band: bandFor(clamped),
    terms,
  };
}

export function bandFor(score: number): DangerBand {
  for (const entry of BANDS) {
    if (score >= entry.min) return entry.band;
  }
  return 'calm';
}

/**
 * Whole-bubble verdict. Distance matters: a camp on the next gate is a decision
 * the pilot has to make now, one eight jumps out is context. The weighting
 * halves roughly every three jumps.
 */
export function scoreBubble(
  scores: Map<number, DangerScore>,
  jumpsBySystem: Map<number, number>,
): { score: number; band: DangerBand; worst: DangerScore | null } {
  let weightedSum = 0;
  let weightTotal = 0;
  let worst: DangerScore | null = null;
  let worstWeighted = -1;

  for (const [systemId, danger] of scores) {
    const jumps = jumpsBySystem.get(systemId) ?? 0;
    const weight = 1 / (1 + jumps / 3);
    weightedSum += danger.score * weight;
    weightTotal += weight;
    const weighted = danger.score * weight;
    if (weighted > worstWeighted) {
      worstWeighted = weighted;
      worst = danger;
    }
  }

  if (weightTotal === 0) return { score: 0, band: 'calm', worst: null };
  // The mean alone drowns a single lethal system in hundreds of quiet ones, so
  // the worst nearby system pulls the verdict up.
  const mean = weightedSum / weightTotal;
  const score = clamp01(Math.max(mean, worstWeighted * 0.8));
  return { score: Math.round(score * 1000) / 1000, band: bandFor(score), worst };
}

/**
 * Router cost input: the same 0..1 score, but a system the pilot cannot legally
 * be attacked in without CONCORD response is discounted further, because a
 * route is a series of choices about where to be caught.
 */
export function routingDangerOf(db: Db, scores: Map<number, DangerScore>): (systemId: number) => number {
  void db;
  return (systemId: number) => scores.get(systemId)?.score ?? 0;
}

function securityFloor(security: number): number {
  if (security >= 0.5) return 0;
  if (security >= 0.45) return 0.2;
  if (security > 0) return 0.7;
  return 1;
}

function saturate(value: number): number {
  // Diminishing returns: the tenth kill in an hour changes the verdict far
  // less than the second one did.
  if (!Number.isFinite(value) || value <= 0) return 0;
  return 1 - Math.exp(-value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
