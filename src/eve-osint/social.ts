import type { OsintKillmail } from './zkill.js';

export type AltCandidate = {
  character_a: number;
  character_b: number;
  confidence: number;
  reasons: string[];
};

export type AltProfile = {
  suspected_alts: AltCandidate[];
  characters_analyzed: number;
};

export type VulnerabilityProfile = {
  loss_hourly_histogram: Record<number, number>;
  peak_loss_hours: number[];
  vulnerable_systems: Array<{ system_id: number; losses: number }>;
  frequently_lost_ships: Array<{ ship_type_id: number; losses: number }>;
  loss_patterns: string[];
  best_ambush_window: { hour: number; day: number; system_id: number } | null;
  vulnerability_score: number;
  total_losses: number;
};

type CharacterProfile = {
  hourly_histogram: number[];
  systems: Set<number>;
  killmail_ids: Set<number>;
};

const MIN_APPEARANCES = 3;
const MIN_CHARACTERS = 5;
const ALT_THRESHOLD = 0.65;
const MAX_ALT_PAIRS = 5;

function utcHour(iso: string): number {
  return new Date(iso).getUTCHours();
}

function utcDay(iso: string): number {
  return new Date(iso).getUTCDay();
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function jaccardIndex(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) {
    if (b.has(v)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function topN<T>(entries: [T, number][], n: number): [T, number][] {
  return entries.sort(([, a], [, b]) => b - a).slice(0, n);
}

function entityMatchesCharacter(
  kill: OsintKillmail,
  scope: 'character' | 'corporation' | 'alliance',
  entityId: number,
  characterId: number,
): boolean {
  if (kill.activity === 'losses') {
    if (kill.victim_character_id === characterId) {
      if (scope === 'character') return entityId === characterId;
      if (scope === 'corporation') return kill.victim_corporation_id === entityId;
      if (scope === 'alliance') return kill.victim_alliance_id === entityId;
    }
    return false;
  }

  for (const atk of kill.attackers) {
    if (atk.character_id !== characterId) continue;
    if (scope === 'character') return entityId === characterId;
    if (scope === 'corporation') return atk.corporation_id === entityId;
    if (scope === 'alliance') return atk.alliance_id === entityId;
  }
  return false;
}

function buildCharacterProfiles(
  kills: OsintKillmail[],
  scope: 'corporation' | 'alliance',
  entityId: number,
): Map<number, CharacterProfile> {
  const profiles = new Map<number, CharacterProfile>();

  function touch(charId: number, kill: OsintKillmail): void {
    if (!entityMatchesCharacter(kill, scope, entityId, charId)) return;

    let prof = profiles.get(charId);
    if (!prof) {
      prof = { hourly_histogram: new Array(24).fill(0) as number[], systems: new Set(), killmail_ids: new Set() };
      profiles.set(charId, prof);
    }
    prof.killmail_ids.add(kill.killmail_id);
    if (kill.killmail_time) prof.hourly_histogram[utcHour(kill.killmail_time)]++;
    if (kill.solar_system_id != null) prof.systems.add(kill.solar_system_id);
  }

  for (const kill of kills) {
    if (kill.victim_character_id != null) touch(kill.victim_character_id, kill);
    for (const atk of kill.attackers) {
      if (atk.character_id != null) touch(atk.character_id, kill);
    }
  }

  return profiles;
}

export function detectAlts(
  kills: OsintKillmail[],
  scope: 'character' | 'corporation' | 'alliance',
  entityId: number,
): AltProfile {
  const empty: AltProfile = { suspected_alts: [], characters_analyzed: 0 };
  if (scope === 'character' || kills.length === 0) return empty;

  const profiles = buildCharacterProfiles(kills, scope, entityId);
  if (profiles.size < MIN_CHARACTERS) return { ...empty, characters_analyzed: profiles.size };

  const eligible = [...profiles.entries()].filter(([, p]) => p.killmail_ids.size >= MIN_APPEARANCES);
  if (eligible.length < 2) return { ...empty, characters_analyzed: profiles.size };

  const candidates: AltCandidate[] = [];

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const [idA, profA] = eligible[i];
      const [idB, profB] = eligible[j];

      let sharedKillmail = false;
      for (const kmId of profA.killmail_ids) {
        if (profB.killmail_ids.has(kmId)) { sharedKillmail = true; break; }
      }
      if (sharedKillmail) continue;

      const tzSim = cosineSimilarity(profA.hourly_histogram, profB.hourly_histogram);
      const spatialSim = jaccardIndex(profA.systems, profB.systems);
      const score = tzSim * 0.5 + spatialSim * 0.3 + 0.2;

      if (score < ALT_THRESHOLD) continue;

      const reasons: string[] = ['never appear in the same killmail'];
      if (tzSim > 0.7) reasons.push(`timezone similarity ${(tzSim * 100).toFixed(0)}%`);
      if (spatialSim > 0.3) reasons.push(`spatial overlap ${(spatialSim * 100).toFixed(0)}%`);

      candidates.push({ character_a: idA, character_b: idB, confidence: Math.round(score * 100) / 100, reasons });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  return {
    suspected_alts: candidates.slice(0, MAX_ALT_PAIRS),
    characters_analyzed: profiles.size,
  };
}

export function analyzeVulnerability(kills: OsintKillmail[]): VulnerabilityProfile {
  const losses = kills.filter((k) => k.activity === 'losses');

  const hourly: Record<number, number> = {};
  const systemHist = new Map<number, number>();
  const shipHist = new Map<number, number>();
  const dayHist = new Map<number, number>();
  const hourValueHist = new Map<number, number>();

  for (const loss of losses) {
    if (loss.killmail_time) {
      const h = utcHour(loss.killmail_time);
      hourly[h] = (hourly[h] ?? 0) + 1;
      const d = utcDay(loss.killmail_time);
      dayHist.set(d, (dayHist.get(d) ?? 0) + 1);
      if (loss.total_value != null && loss.total_value > 500_000_000) {
        hourValueHist.set(h, (hourValueHist.get(h) ?? 0) + 1);
      }
    }
    if (loss.solar_system_id != null) {
      systemHist.set(loss.solar_system_id, (systemHist.get(loss.solar_system_id) ?? 0) + 1);
    }
    if (loss.ship_type_id != null) {
      shipHist.set(loss.ship_type_id, (shipHist.get(loss.ship_type_id) ?? 0) + 1);
    }
  }

  const peakHours = topN(Object.entries(hourly).map(([h, c]) => [Number(h), c] as [number, number]), 3).map(([h]) => h);
  const vulnerableSystems = topN([...systemHist.entries()], 3).map(([system_id, l]) => ({ system_id, losses: l }));
  const frequentlyLostShips = topN([...shipHist.entries()], 5).map(([ship_type_id, l]) => ({ ship_type_id, losses: l }));

  const patterns: string[] = [];

  if (peakHours.length >= 2) {
    const sorted = [...peakHours].sort((a, b) => a - b);
    const span = (sorted[sorted.length - 1] - sorted[0] + 24) % 24;
    if (span <= 3) {
      patterns.push(`concentrated loss window: ${String(sorted[0]).padStart(2, '0')}:00-${String((sorted[sorted.length - 1] + 1) % 24).padStart(2, '0')}:00 UTC`);
    }
  }

  const soloLosses = losses.filter((l) => l.attacker_count >= 1 && l.attacker_count <= 3).length;
  if (losses.length > 0 && soloLosses / losses.length > 0.5) {
    patterns.push('picked off while solo');
  }

  if (vulnerableSystems.length > 0 && losses.length > 0 && vulnerableSystems[0].losses / losses.length > 0.4) {
    patterns.push(`dies repeatedly in system:${vulnerableSystems[0].system_id}`);
  }

  if (hourValueHist.size > 0) {
    const peakExpensive = topN([...hourValueHist.entries()], 1);
    if (peakExpensive.length > 0 && peakExpensive[0][1] >= 2) {
      patterns.push(`expensive losses during ${String(peakExpensive[0][0]).padStart(2, '0')}:00 UTC`);
    }
  }

  let bestAmbush: VulnerabilityProfile['best_ambush_window'] = null;
  if (peakHours.length > 0 && vulnerableSystems.length > 0 && dayHist.size > 0) {
    const peakDay = topN([...dayHist.entries()], 1)[0][0];
    bestAmbush = { hour: peakHours[0], day: peakDay, system_id: vulnerableSystems[0].system_id };
  }

  const score = computeVulnerabilityScore(hourly, losses.length);

  return {
    loss_hourly_histogram: hourly,
    peak_loss_hours: peakHours,
    vulnerable_systems: vulnerableSystems,
    frequently_lost_ships: frequentlyLostShips,
    loss_patterns: patterns,
    best_ambush_window: bestAmbush,
    vulnerability_score: score,
    total_losses: losses.length,
  };
}

function computeVulnerabilityScore(hourly: Record<number, number>, total: number): number {
  if (total === 0) return 0;

  let entropy = 0;
  for (const count of Object.values(hourly)) {
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  const maxEntropy = Math.log2(24);
  return Math.round((1 - entropy / maxEntropy) * 100) / 100;
}
