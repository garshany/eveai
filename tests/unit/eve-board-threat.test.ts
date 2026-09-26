import { describe, expect, it } from 'vitest';
import { analyzeKillPattern, scoreThreat } from '../../src/eve-board/threat.js';
import type { ShipAssessment, ThreatKillmail } from '../../src/eve-board/types.js';

const now = Date.now();
const minutesAgo = (m: number): string => new Date(now - m * 60_000).toISOString();

function haulerVictim(shipEhp = 9_000): ShipAssessment {
  return {
    shipTypeId: 648,
    shipName: 'Badger',
    ehp: shipEhp,
    alignTime: 10,
    warpSpeed: 4,
    shipClass: 'hauler',
    isHighValueTarget: true,
    survivalChance: 'DEAD',
  };
}

describe('analyzeKillPattern', () => {
  it('estimates DPS from the real fleet size (attacker_count), not the final-blow count', () => {
    // Four kills, four distinct final-blowers, but each killmail lists a large
    // attacker fleet. DPS must reflect the peak fleet (20), not 4 final-blows.
    const kills: ThreatKillmail[] = [
      { killmail_id: 1, killmail_time: minutesAgo(2), attacker_count: 12, is_npc: false, final_blow_character_id: 100 },
      { killmail_id: 2, killmail_time: minutesAgo(2), attacker_count: 15, is_npc: false, final_blow_character_id: 101 },
      { killmail_id: 3, killmail_time: minutesAgo(1), attacker_count: 20, is_npc: false, final_blow_character_id: 102 },
    ];
    const pattern = analyzeKillPattern(kills, 30_000_142, 'Uedama', 0.5);

    expect(pattern.peakAttackerCount).toBe(20);
    expect(pattern.estimatedGankDps).toBe(20 * 400); // was 3 * 400 when counting final-blows
  });

  it('counts the recent cluster and is not widened by an older stray kill', () => {
    const kills: ThreatKillmail[] = [
      { killmail_id: 1, killmail_time: minutesAgo(55), attacker_count: 5, is_npc: false, final_blow_character_id: 100 },
      { killmail_id: 2, killmail_time: minutesAgo(3), attacker_count: 15, is_npc: false, final_blow_character_id: 101 },
      { killmail_id: 3, killmail_time: minutesAgo(2), attacker_count: 16, is_npc: false, final_blow_character_id: 102 },
      { killmail_id: 4, killmail_time: minutesAgo(1), attacker_count: 18, is_npc: false, final_blow_character_id: 103 },
    ];
    const pattern = analyzeKillPattern(kills, 30_000_142, 'Uedama', 0.5);

    // The three recent kills cluster within 15 min of the latest; the 55-min-old
    // kill is excluded, even though the full span is ~54 min.
    expect(pattern.recentKillCount).toBe(3);
    expect(pattern.timeWindowMinutes).toBeGreaterThan(50);
  });
});

describe('scoreThreat active gank fleet', () => {
  it('flags an active fleet even when an older kill widens the total time window', () => {
    // Regression: the active-fleet test compared the full earliest→latest span
    // against the window, so one 55-min-old kill dropped a burst of three kills
    // in the last three minutes to MEDIUM. And DPS was counted from final-blows,
    // understating a large fleet.
    const kills: ThreatKillmail[] = [
      { killmail_id: 1, killmail_time: minutesAgo(55), attacker_count: 6, is_npc: false, final_blow_character_id: 100 },
      { killmail_id: 2, killmail_time: minutesAgo(3), attacker_count: 15, is_npc: false, final_blow_character_id: 101 },
      { killmail_id: 3, killmail_time: minutesAgo(2), attacker_count: 18, is_npc: false, final_blow_character_id: 102 },
      { killmail_id: 4, killmail_time: minutesAgo(1), attacker_count: 20, is_npc: false, final_blow_character_id: 103 },
    ];
    const pattern = analyzeKillPattern(kills, 30_000_142, 'Uedama', 0.5);
    const score = scoreThreat(pattern, haulerVictim());

    expect(score.level).toBe('CRITICAL');
    expect(score.reason).toContain('20'); // reports the real fleet size / DPS
  });

  it('does not treat an old cluster as an active fleet once it is stale', () => {
    // Same shape, but the whole cluster is 40+ minutes old — not active now.
    const kills: ThreatKillmail[] = [
      { killmail_id: 1, killmail_time: minutesAgo(44), attacker_count: 15, is_npc: false, final_blow_character_id: 101 },
      { killmail_id: 2, killmail_time: minutesAgo(42), attacker_count: 18, is_npc: false, final_blow_character_id: 102 },
      { killmail_id: 3, killmail_time: minutesAgo(41), attacker_count: 20, is_npc: false, final_blow_character_id: 103 },
    ];
    const pattern = analyzeKillPattern(kills, 30_000_142, 'Uedama', 0.5);
    const score = scoreThreat(pattern, haulerVictim());

    expect(score.level).not.toBe('CRITICAL');
    expect(score.level).not.toBe('HIGH');
  });
});
