import { describe, expect, it } from 'vitest';
import { bandFor, scoreBubble, scoreSystemDanger, type DangerInput } from '../../src/eve-map/danger.js';
import type { SystemKillRollup } from '../../src/eve-map/kill-index.js';
import type { ShipAssessment } from '../../src/eve-board/types.js';

function rollup(overrides: Partial<SystemKillRollup> = {}): SystemKillRollup {
  return {
    systemId: 30000142,
    kills15m: 0,
    kills1h: 0,
    killsWindow: 0,
    killsWindowHours: 3,
    pvpKills1h: 0,
    npcKills1h: 0,
    valueDestroyed1h: 0,
    soloKills1h: 0,
    lastKillMinutesAgo: null,
    lastKillAtMs: null,
    ...overrides,
  };
}

function input(overrides: Partial<DangerInput> = {}): DangerInput {
  return {
    systemId: 30000142,
    security: 0.9,
    rollup: rollup(),
    attackers: [],
    maxGateKills: 0,
    victimGroups: [],
    baselineShipKills1h: 0,
    pilotShip: null,
    ...overrides,
  };
}

function ship(overrides: Partial<ShipAssessment> = {}): ShipAssessment {
  return {
    shipTypeId: 648,
    shipName: 'Badger',
    ehp: 8000,
    alignTime: 11,
    warpSpeed: 4.5,
    shipClass: 'hauler',
    isHighValueTarget: true,
    survivalChance: 'UNLIKELY',
    ...overrides,
  };
}

describe('danger scoring', () => {
  it('labels the quiet discount with the real kill window, not a fictional 24 h', () => {
    const quiet = scoreSystemDanger(input({ security: -0.5 }));
    const term = quiet.terms.find((entry) => entry.key === 'quiet_discount');
    expect(term?.detail).toBe('nothing observed here in the last 3 hour(s)');
    expect(term?.detail).not.toContain('24');
  });

  it('scores a quiet highsec system near zero', () => {
    const score = scoreSystemDanger(input());
    expect(score.score).toBeLessThan(0.1);
    expect(score.band).toBe('calm');
  });

  it('always returns the terms behind the score', () => {
    const score = scoreSystemDanger(input({
      security: 0.4,
      rollup: rollup({ kills1h: 4, kills15m: 3, killsWindow: 6, pvpKills1h: 4 }),
    }));
    // Красная точка без разбора — не разведданные.
    expect(score.terms.length).toBeGreaterThan(0);
    const sum = score.terms.reduce((total, term) => total + term.value, 0);
    expect(score.score).toBeCloseTo(Math.min(1, sum), 2);
  });

  it('weighs recent kills above older ones', () => {
    const fresh = scoreSystemDanger(input({
      rollup: rollup({ kills1h: 4, kills15m: 4, killsWindow: 4, pvpKills1h: 4 }),
    }));
    const stale = scoreSystemDanger(input({
      rollup: rollup({ kills1h: 4, kills15m: 0, killsWindow: 4, pvpKills1h: 4 }),
    }));
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it('raises the score when the same attacker keeps killing', () => {
    const once = scoreSystemDanger(input({
      rollup: rollup({ kills1h: 2, killsWindow: 2, pvpKills1h: 2 }),
      attackers: [{ characterId: 1, name: 'A', kills: 1 }, { characterId: 2, name: 'B', kills: 1 }],
    }));
    const repeat = scoreSystemDanger(input({
      rollup: rollup({ kills1h: 2, killsWindow: 2, pvpKills1h: 2 }),
      attackers: [{ characterId: 1, name: 'A', kills: 2 }],
    }));
    expect(repeat.score).toBeGreaterThan(once.score);
    expect(repeat.terms.some((term) => term.key === 'repeat_attackers')).toBe(true);
  });

  it('flags a gate camp separately from scattered kills', () => {
    const scattered = scoreSystemDanger(input({
      rollup: rollup({ kills1h: 4, killsWindow: 4, pvpKills1h: 4 }),
      maxGateKills: 1,
    }));
    const camped = scoreSystemDanger(input({
      rollup: rollup({ kills1h: 4, killsWindow: 4, pvpKills1h: 4 }),
      maxGateKills: 4,
    }));
    expect(camped.score).toBeGreaterThan(scattered.score);
    expect(camped.terms.some((term) => term.key === 'gate_camp')).toBe(true);
  });

  it('scores the same system higher for a hull that cannot survive there', () => {
    const base = input({ rollup: rollup({ kills1h: 3, killsWindow: 3, pvpKills1h: 3 }) });
    const anonymous = scoreSystemDanger(base);
    const hauler = scoreSystemDanger({ ...base, pilotShip: ship({ survivalChance: 'DEAD' }) });
    // Вопрос всегда «опасно ли мне», а не «опасно ли вообще».
    expect(hauler.score).toBeGreaterThan(anonymous.score);
    expect(hauler.terms.some((term) => term.key === 'capability_gap')).toBe(true);
  });

  it('notices that this system eats hulls like the pilot\'s', () => {
    const score = scoreSystemDanger(input({
      rollup: rollup({ kills1h: 2, killsWindow: 2, pvpKills1h: 2 }),
      victimGroups: ['hauler', 'hauler'],
      pilotShip: ship(),
    }));
    expect(score.terms.some((term) => term.key === 'victim_similarity')).toBe(true);
  });

  it('does not paint an empty nullsec system above a camped highsec gate', () => {
    const emptyNull = scoreSystemDanger(input({ systemId: 1, security: -0.5 }));
    const campedHigh = scoreSystemDanger(input({
      systemId: 2,
      security: 0.9,
      rollup: rollup({ kills15m: 3, kills1h: 5, killsWindow: 5, pvpKills1h: 5 }),
      maxGateKills: 4,
      attackers: [{ characterId: 1, name: 'Ganker', kills: 4 }],
    }));
    // Без скидки за тишину весь нулл красный, и карта бесполезна там, где важнее всего.
    expect(emptyNull.score).toBeLessThan(campedHigh.score);
    expect(emptyNull.terms.some((term) => term.key === 'quiet_discount')).toBe(true);
  });

  it('keeps structural risk for a nullsec system that does see activity', () => {
    const quiet = scoreSystemDanger(input({ security: -0.5 }));
    const active = scoreSystemDanger(input({
      security: -0.5,
      rollup: rollup({ kills1h: 1, killsWindow: 1, pvpKills1h: 1 }),
    }));
    expect(active.score).toBeGreaterThan(quiet.score);
  });

  it('maps scores onto bands', () => {
    expect(bandFor(0)).toBe('calm');
    expect(bandFor(0.2)).toBe('watch');
    expect(bandFor(0.4)).toBe('elevated');
    expect(bandFor(0.65)).toBe('hostile');
    expect(bandFor(0.9)).toBe('lethal');
  });
});

describe('bubble verdict', () => {
  const dangerous = scoreSystemDanger(input({
    systemId: 1,
    security: 0.4,
    rollup: rollup({ kills15m: 5, kills1h: 8, killsWindow: 8, pvpKills1h: 8 }),
    maxGateKills: 5,
    attackers: [{ characterId: 1, name: 'Ganker', kills: 5 }],
  }));
  const quiet = scoreSystemDanger(input({ systemId: 2 }));

  it('weights nearby systems above distant ones', () => {
    const near = scoreBubble(
      new Map([[1, dangerous], [2, quiet]]),
      new Map([[1, 1], [2, 1]]),
    );
    const far = scoreBubble(
      new Map([[1, dangerous], [2, quiet]]),
      new Map([[1, 9], [2, 1]]),
    );
    expect(near.score).toBeGreaterThan(far.score);
  });

  it('does not drown one lethal system in many quiet ones', () => {
    const scores = new Map([[1, dangerous]]);
    const jumps = new Map([[1, 1]]);
    for (let id = 100; id < 200; id += 1) {
      scores.set(id, scoreSystemDanger(input({ systemId: id })));
      jumps.set(id, 2);
    }
    const verdict = scoreBubble(scores, jumps);
    expect(verdict.worst?.systemId).toBe(1);
    expect(verdict.score).toBeGreaterThan(0.3);
  });

  it('returns calm for an empty bubble', () => {
    const verdict = scoreBubble(new Map(), new Map());
    expect(verdict.band).toBe('calm');
    expect(verdict.worst).toBeNull();
  });
});
