import { describe, expect, it } from 'vitest';
import { createAdvisorState, evaluateAdvisories, type AdvisorContext } from '../../src/eve-map/advisor.js';
import type { BubblePayload, BubbleSystem } from '../../src/eve-map/bubble.js';
import type { ShipAssessment } from '../../src/eve-board/types.js';

/**
 * Регрессия на реальный полёт: одно и то же «ОН ТЕБЯ ДОГОНИТ» прилетело восемь
 * раз за десять минут, потому что состояние («ты на Gila там, где стреляют»)
 * было реализовано как событие с таймером.
 */

const MINUTE = 60_000;
const START = Date.parse('2026-07-29T19:00:00.000Z');

const GILA: ShipAssessment = {
  shipTypeId: 17715,
  shipName: 'Gila',
  ehp: 13_290,
  alignTime: 8.8,
  warpSpeed: 3,
  shipClass: 'cruiser',
  isHighValueTarget: false,
  survivalChance: 'UNLIKELY',
};

function system(overrides: Partial<BubbleSystem> & { systemId: number }): BubbleSystem {
  return {
    name: `S${overrides.systemId}`,
    jumps: 1,
    security: 0.3,
    securityClass: null,
    regionId: 1,
    regionName: 'R',
    mapX: 0,
    mapY: 0,
    whClass: null,
    activity: {
      systemId: overrides.systemId,
      kills15m: 2, kills1h: 4, killsWindow: 9, killsWindowHours: 3,
      pvpKills1h: 4, npcKills1h: 0, valueDestroyed1h: 5e6, soloKills1h: 1,
      lastKillMinutesAgo: 3, lastKillAtMs: START,
    },
    baselineShipKills: 0,
    baselineNpcKills: 0,
    baselineJumps: 0,
    sovereigntyAllianceId: null,
    sovereigntyFactionId: null,
    gateCamps: [],
    danger: { systemId: overrides.systemId, score: 0.5, band: 'elevated', terms: [] },
    ...overrides,
  } as BubbleSystem;
}

function bubble(systems: BubbleSystem[]): BubblePayload {
  return {
    originId: 30000001,
    radius: 5,
    requestedRadius: 5,
    truncated: false,
    systems,
    edges: [],
    wormholes: [],
    recentKills: [],
    verdict: { score: 0.5, band: 'elevated', worstSystemId: systems[0]?.systemId ?? null },
    pilotShip: GILA,
    freshness: [],
    builtAt: new Date(START).toISOString(),
  } as BubblePayload;
}

function context(now: number, currentSystemId = 30000001, systems?: BubbleSystem[]): AdvisorContext {
  return {
    bubble: bubble(systems ?? [system({ systemId: 30000002, jumps: 2 })]),
    currentSystemId,
    routeAhead: [],
    newKills: [],
    now,
  };
}

const rulesIn = (list: ReturnType<typeof evaluateAdvisories>): string[] => list.map((a) => a.rule);

describe('level rules are said once, not on a timer', () => {
  it('announces the capability gap once and then stays quiet', () => {
    const state = createAdvisorState(START);

    const first = evaluateAdvisories(state, context(START));
    expect(rulesIn(first)).toContain('capability_gap');

    // Десять минут полёта, ситуация та же. Раньше здесь было ещё восемь копий.
    for (let minute = 1; minute <= 10; minute += 1) {
      const later = evaluateAdvisories(state, context(START + minute * MINUTE));
      expect(rulesIn(later)).not.toContain('capability_gap');
    }
  });

  it('speaks again when the situation itself changes', () => {
    const state = createAdvisorState(START);
    evaluateAdvisories(state, context(START));

    // Другая система — другой факт, и о нём стоит сказать.
    const elsewhere = evaluateAdvisories(
      state,
      context(START + 2 * MINUTE, 30000001, [system({ systemId: 30000099, jumps: 1 })]),
    );
    expect(rulesIn(elsewhere)).toContain('capability_gap');
  });

  it('counts what it suppressed instead of losing it', () => {
    const state = createAdvisorState(START);
    evaluateAdvisories(state, context(START));
    for (let minute = 1; minute <= 4; minute += 1) {
      evaluateAdvisories(state, context(START + minute * MINUTE));
    }

    const changed = evaluateAdvisories(
      state,
      context(START + 5 * MINUTE, 30000001, [system({ systemId: 30000099, jumps: 1 })]),
    );
    const gap = changed.find((advisory) => advisory.rule === 'capability_gap')!;
    expect(gap.repeats).toBe(4);
  });

  it('re-arms only after the condition has been gone a long while', () => {
    const state = createAdvisorState(START);
    evaluateAdvisories(state, context(START));

    // Условие исчезло: рядом ничего не стреляет.
    const quiet = system({ systemId: 30000002, jumps: 2 });
    quiet.activity = { ...quiet.activity, pvpKills1h: 0, kills15m: 0, kills1h: 0 };
    evaluateAdvisories(state, context(START + MINUTE, 30000001, [quiet]));

    // Вернулось через минуту — это дребезг у порога, а не новость.
    const flicker = evaluateAdvisories(state, context(START + 2 * MINUTE));
    expect(rulesIn(flicker)).not.toContain('capability_gap');

    // Спустя долгое отсутствие — уже новость.
    evaluateAdvisories(state, context(START + 12 * MINUTE, 30000001, [quiet]));
    const returned = evaluateAdvisories(state, context(START + 25 * MINUTE));
    expect(rulesIn(returned)).toContain('capability_gap');
  });

  it('keeps edge rules on their cooldown path', () => {
    const state = createAdvisorState(START);
    // security_band — переход, а не состояние: он одноразовый по построению.
    const first = evaluateAdvisories(
      state,
      context(START, 30000001, [system({ systemId: 30000001, jumps: 0, security: 0.9 })]),
    );
    expect(rulesIn(first)).not.toContain('security_band');

    const dropped = evaluateAdvisories(
      state,
      context(START + MINUTE, 30000001, [system({ systemId: 30000001, jumps: 0, security: 0.3 })]),
    );
    expect(rulesIn(dropped)).toContain('security_band');
  });
});
