import { describe, expect, it } from 'vitest';
import {
  createAdvisorState,
  evaluateAdvisories,
  getSharedAdvisorState,
  markModelCall,
  releaseSharedAdvisorState,
  resetSharedAdvisorStatesForTests,
  shouldEscalateToModel,
  type AdvisorContext,
} from '../../src/eve-map/advisor.js';
import { config } from '../../src/config.js';
import type { BubblePayload, BubbleSystem } from '../../src/eve-map/bubble.js';
import type { IndexedKill } from '../../src/eve-map/kill-index.js';
import type { DangerBand } from '../../src/eve-map/danger.js';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function system(overrides: Partial<BubbleSystem> & { systemId: number }): BubbleSystem {
  return {
    name: `System ${overrides.systemId}`,
    jumps: 1,
    security: 0.9,
    securityClass: null,
    regionId: 1,
    regionName: 'Region',
    mapX: 0,
    mapY: 0,
    whClass: null,
    activity: {
      systemId: overrides.systemId,
      kills15m: 0,
      kills1h: 0,
      kills24h: 0,
      pvpKills1h: 0,
      npcKills1h: 0,
      valueDestroyed1h: 0,
      soloKills1h: 0,
      lastKillMinutesAgo: null,
      lastKillAtMs: null,
    },
    baselineShipKills: 0,
    baselineNpcKills: 0,
    baselineJumps: 0,
    sovereigntyAllianceId: null,
    sovereigntyFactionId: null,
    gateCamps: [],
    danger: { systemId: overrides.systemId, score: 0, band: 'calm', terms: [] },
    ...overrides,
  };
}

function kill(overrides: Partial<IndexedKill> & { killmailId: number; systemId: number }): IndexedKill {
  return {
    regionId: 1,
    killmailTime: new Date(NOW - 60_000).toISOString(),
    killmailTimeMs: NOW - 60_000,
    totalValue: 10_000_000,
    attackerCount: 1,
    isNpc: false,
    isSolo: true,
    victimShipTypeId: 648,
    victimShipName: 'Badger',
    victimShipGroupName: 'hauler',
    victimCharacterId: 1,
    victimCharacterName: 'Victim',
    victimCorporationName: 'Corp',
    finalBlowCharacterId: 7,
    finalBlowCharacterName: 'Hunter',
    finalBlowShipTypeId: 11567,
    finalBlowShipName: 'Loki',
    position: null,
    ...overrides,
  };
}

function bubble(overrides: Partial<BubblePayload> = {}): BubblePayload {
  return {
    originId: 1,
    radius: 3,
    requestedRadius: 3,
    truncated: false,
    systems: [system({ systemId: 1, jumps: 0 })],
    edges: [],
    wormholes: [],
    recentKills: [],
    verdict: { score: 0, band: 'calm', worstSystemId: null },
    pilotShip: null,
    freshness: [],
    builtAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function ctx(overrides: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    bubble: bubble(),
    currentSystemId: 1,
    routeAhead: [],
    newKills: [],
    now: NOW,
    ...overrides,
  };
}

describe('perimeter advisor', () => {
  it('says nothing about a quiet perimeter on the first tick', () => {
    const state = createAdvisorState(NOW);
    expect(evaluateAdvisories(state, ctx())).toHaveLength(0);
  });

  it('names the hunters when the same attacker follows the pilot', () => {
    const state = createAdvisorState(NOW);
    // Пилот прошёл 1 → 2 → 3, и один и тот же стрелок убивал в двух из них.
    evaluateAdvisories(state, ctx({ currentSystemId: 1 }));
    evaluateAdvisories(state, ctx({ currentSystemId: 2 }));

    const advisories = evaluateAdvisories(state, ctx({
      currentSystemId: 3,
      bubble: bubble({
        systems: [system({ systemId: 3, jumps: 0 })],
        recentKills: [
          kill({ killmailId: 1, systemId: 1 }),
          kill({ killmailId: 2, systemId: 2 }),
        ],
      }),
    }));

    const pursuit = advisories.find((advisory) => advisory.rule === 'pursuit');
    expect(pursuit).toBeDefined();
    expect(pursuit!.severity).toBe('danger');
    expect(pursuit!.text.ru).toContain('Hunter');
  });

  it('does not call a single attacker in one system a pursuit', () => {
    const state = createAdvisorState(NOW);
    evaluateAdvisories(state, ctx({ currentSystemId: 1 }));
    const advisories = evaluateAdvisories(state, ctx({
      currentSystemId: 2,
      bubble: bubble({ recentKills: [kill({ killmailId: 1, systemId: 1 })] }),
    }));
    expect(advisories.find((advisory) => advisory.rule === 'pursuit')).toBeUndefined();
  });

  it('warns about a camp on the next hop', () => {
    const state = createAdvisorState(NOW);
    const advisories = evaluateAdvisories(state, ctx({
      bubble: bubble({
        systems: [
          system({ systemId: 1, jumps: 0 }),
          system({
            systemId: 2,
            jumps: 1,
            name: 'Uedama',
            gateCamps: [{
              systemId: 2,
              systemName: 'Uedama',
              stargateId: 50,
              connectedSystemName: 'Sivala',
              killCount: 3,
              recentKills: 2,
            }],
          }),
        ],
      }),
    }));

    const camp = advisories.find((advisory) => advisory.rule === 'camp_next_hop');
    expect(camp).toBeDefined();
    expect(camp!.text.ru).toContain('Uedama');
    expect(camp!.systemId).toBe(2);
  });

  it('reports a rising threat band but not a falling one', () => {
    const state = createAdvisorState(NOW);
    evaluateAdvisories(state, ctx({ bubble: bubble({ verdict: { score: 0.1, band: 'calm', worstSystemId: null } }) }));

    const rising = evaluateAdvisories(state, ctx({
      now: NOW + 600_000,
      bubble: bubble({ verdict: { score: 0.7, band: 'hostile', worstSystemId: 1 } }),
    }));
    expect(rising.find((advisory) => advisory.rule === 'threat_rise')).toBeDefined();

    const falling = evaluateAdvisories(state, ctx({
      now: NOW + 1_200_000,
      bubble: bubble({ verdict: { score: 0.1, band: 'calm', worstSystemId: null } }),
    }));
    expect(falling.find((advisory) => advisory.rule === 'threat_rise')).toBeUndefined();
  });

  it('calls out a value spike with the hull and the amount', () => {
    const state = createAdvisorState(NOW);
    const big = kill({ killmailId: 5, systemId: 2, totalValue: 4_000_000_000, victimShipName: 'Charon' });
    const advisories = evaluateAdvisories(state, ctx({
      bubble: bubble({
        systems: [system({ systemId: 1, jumps: 0 }), system({ systemId: 2, jumps: 2, name: 'Niarja' })],
        recentKills: [big],
      }),
      newKills: [big],
    }));

    const spike = advisories.find((advisory) => advisory.rule === 'value_spike');
    expect(spike).toBeDefined();
    expect(spike!.text.ru).toContain('Charon');
    expect(spike!.killmailId).toBe(5);
  });

  it('judges a kill once even when several tabs hand it over', () => {
    // Две вкладки делят одно состояние и обе передают тот же килл. Второй
    // проход раньше засчитывался как «подавленный повтор», и следующая
    // настоящая тревога приходила как «×2».
    const state = createAdvisorState(NOW);
    const big = kill({ killmailId: 7, systemId: 2, totalValue: 4_000_000_000 });
    const frame = bubble({
      systems: [system({ systemId: 1, jumps: 0 }), system({ systemId: 2, jumps: 1 })],
      recentKills: [big],
    });
    const first = evaluateAdvisories(state, ctx({ bubble: frame, newKills: [big] }));
    const second = evaluateAdvisories(state, ctx({ bubble: frame, newKills: [big], now: NOW + 1_000 }));
    expect(first.filter((advisory) => advisory.rule === 'value_spike')).toHaveLength(1);
    expect(second.filter((advisory) => advisory.rule === 'value_spike')).toHaveLength(0);
    expect(state.suppressed.get('value_spike') ?? 0).toBe(0);
  });

  it('warns when the pilot leaves highsec, and stays quiet coming back', () => {
    const state = createAdvisorState(NOW);
    evaluateAdvisories(state, ctx());

    const leaving = evaluateAdvisories(state, ctx({
      now: NOW + 600_000,
      currentSystemId: 2,
      bubble: bubble({ systems: [system({ systemId: 2, jumps: 0, security: 0.3, name: 'Tama' })] }),
    }));
    expect(leaving.find((advisory) => advisory.rule === 'security_band')).toBeDefined();

    const returning = evaluateAdvisories(state, ctx({
      now: NOW + 1_200_000,
      currentSystemId: 1,
      bubble: bubble({ systems: [system({ systemId: 1, jumps: 0, security: 0.9 })] }),
    }));
    expect(returning.find((advisory) => advisory.rule === 'security_band')).toBeUndefined();
  });

  it('flags a route that went red and says which hop', () => {
    const state = createAdvisorState(NOW);
    const advisories = evaluateAdvisories(state, ctx({
      routeAhead: [2, 3],
      bubble: bubble({
        systems: [
          system({ systemId: 1, jumps: 0 }),
          system({ systemId: 2, jumps: 1 }),
          system({
            systemId: 3,
            jumps: 2,
            name: 'Rancer',
            danger: { systemId: 3, score: 0.9, band: 'lethal', terms: [] },
          }),
        ],
      }),
    }));
    const degraded = advisories.find((advisory) => advisory.rule === 'route_degraded');
    expect(degraded).toBeDefined();
    expect(degraded!.text.ru).toContain('Rancer');
  });

  it('collapses repeats inside the cooldown into one message with a counter', () => {
    const state = createAdvisorState(NOW);
    const campBubble = bubble({
      systems: [
        system({ systemId: 1, jumps: 0 }),
        system({
          systemId: 2,
          jumps: 1,
          gateCamps: [{
            systemId: 2, systemName: 'X', stargateId: 1, connectedSystemName: 'Y', killCount: 3, recentKills: 1,
          }],
        }),
      ],
    });

    const first = evaluateAdvisories(state, ctx({ bubble: campBubble }));
    expect(first.find((advisory) => advisory.rule === 'camp_next_hop')).toBeDefined();

    // Внутри кулдауна повтор молчит.
    const second = evaluateAdvisories(state, ctx({ bubble: campBubble, now: NOW + 1000 }));
    expect(second.find((advisory) => advisory.rule === 'camp_next_hop')).toBeUndefined();

    // И после кулдауна тоже молчит: кемп — это состояние, а не событие.
    // Пересказывать его по таймеру — ровно тот спам, из-за которого пилот
    // перестаёт читать панель (в реальном полёте одно и то же предупреждение
    // прилетело восемь раз за десять минут).
    const later = evaluateAdvisories(state, ctx({
      bubble: campBubble,
      now: NOW + config.map.advisorCooldownSeconds * 1000 + 1000,
    }));
    expect(later.find((advisory) => advisory.rule === 'camp_next_hop')).toBeUndefined();
  });

  it('orders the loudest advisory first', () => {
    const state = createAdvisorState(NOW);
    // Первый тик задаёт исходную зону безопасности: смена зоны существует
    // только относительно предыдущей.
    evaluateAdvisories(state, ctx());
    const advisories = evaluateAdvisories(state, ctx({
      now: NOW + 60_000,
      bubble: bubble({
        systems: [
          system({ systemId: 1, jumps: 0, security: 0.3 }),
          system({
            systemId: 2,
            jumps: 1,
            gateCamps: [{
              systemId: 2, systemName: 'X', stargateId: 1, connectedSystemName: 'Y', killCount: 4, recentKills: 2,
            }],
          }),
        ],
      }),
    }));
    expect(advisories.length).toBeGreaterThan(1);
    expect(advisories[0]!.severity).toBe('danger');
  });

  it('reports all clear only after a sustained quiet stretch', () => {
    const state = createAdvisorState(NOW);
    evaluateAdvisories(state, ctx());
    expect(evaluateAdvisories(state, ctx({ now: NOW + 60_000 }))
      .find((advisory) => advisory.rule === 'all_clear')).toBeUndefined();

    const later = evaluateAdvisories(state, ctx({ now: NOW + 16 * 60_000 }));
    expect(later.find((advisory) => advisory.rule === 'all_clear')).toBeDefined();
  });

  describe('model escalation', () => {
    const danger = {
      rule: 'camp_next_hop' as const,
      severity: 'danger' as const,
      text: { ru: '', en: '' },
      systemId: 1,
      killmailId: null,
      repeats: 0,
      at: new Date(NOW).toISOString(),
    };
    const info = { ...danger, rule: 'all_clear' as const, severity: 'info' as const };

    it('never escalates without an advisory', () => {
      expect(shouldEscalateToModel(createAdvisorState(NOW), [], NOW)).toBe(false);
    });

    it('does not escalate routine chatter', () => {
      expect(shouldEscalateToModel(createAdvisorState(NOW), [info], NOW)).toBe(false);
    });

    it('escalates a danger advisory once per cooldown', () => {
      const state = createAdvisorState(NOW);
      expect(shouldEscalateToModel(state, [danger], NOW)).toBe(true);
      markModelCall(state, NOW);
      // Час полёта не должен стоить вызова модели каждые пять секунд.
      expect(shouldEscalateToModel(state, [danger], NOW + 5_000)).toBe(false);
      expect(shouldEscalateToModel(
        state,
        [danger],
        NOW + config.map.advisorLlmCooldownSeconds * 1000 + 1000,
      )).toBe(true);
    });
  });

  it('bounds the seen-kill set over a long flight', () => {
    const state = createAdvisorState(NOW);
    for (let index = 0; index < 2600; index += 1) {
      evaluateAdvisories(state, ctx({
        now: NOW + index * 1000,
        newKills: [kill({ killmailId: index, systemId: 1 })],
      }));
    }
    expect(state.seenKillIds.size).toBeLessThanOrEqual(2001);
  });

  it('bounds the pilot trail', () => {
    const state = createAdvisorState(NOW);
    for (let index = 0; index < 60; index += 1) {
      evaluateAdvisories(state, ctx({ currentSystemId: index, now: NOW + index * 1000 }));
    }
    expect(state.trail.length).toBeLessThanOrEqual(20);
  });
});

describe('danger band ordering used by the advisor', () => {
  it('treats bands as ordered severity', () => {
    const bands: DangerBand[] = ['calm', 'watch', 'elevated', 'hostile', 'lethal'];
    const state = createAdvisorState(NOW);
    evaluateAdvisories(state, ctx({ bubble: bubble({ verdict: { score: 0, band: 'calm', worstSystemId: null } }) }));

    for (const [index, band] of bands.slice(1).entries()) {
      const advisories = evaluateAdvisories(state, ctx({
        now: NOW + (index + 1) * 10 * 60_000,
        bubble: bubble({ verdict: { score: 0.5, band, worstSystemId: null } }),
      }));
      expect(advisories.find((advisory) => advisory.rule === 'threat_rise')).toBeDefined();
    }
  });
});

describe('shared advisor state', () => {
  it('gives every tab of one character the same state', () => {
    // Иначе три вкладки трижды запишут одно и то же предупреждение в один тред.
    const first = getSharedAdvisorState(90_000_001, NOW);
    const second = getSharedAdvisorState(90_000_001, NOW);
    expect(second).toBe(first);
    resetSharedAdvisorStatesForTests();
  });

  it('keeps characters apart', () => {
    const a = getSharedAdvisorState(90_000_001, NOW);
    const b = getSharedAdvisorState(90_000_002, NOW);
    expect(b).not.toBe(a);
    resetSharedAdvisorStatesForTests();
  });

  it('survives a reconnect so cooldowns are not reset', () => {
    const first = getSharedAdvisorState(90_000_003, NOW);
    releaseSharedAdvisorState(90_000_003, NOW);
    // Переподключение SSE (смена радиуса, обрыв сокета) не должно обнулять
    // кулдауны: на бою из-за этого одно и то же предупреждение пришло трижды
    // за восемьдесят секунд.
    expect(getSharedAdvisorState(90_000_003, NOW + 30_000)).toBe(first);
    resetSharedAdvisorStatesForTests();
  });

  it('starts clean once nobody has watched for a long time', () => {
    const first = getSharedAdvisorState(90_000_004, NOW);
    releaseSharedAdvisorState(90_000_004, NOW);
    expect(getSharedAdvisorState(90_000_004, NOW + 20 * 60_000)).not.toBe(first);
    resetSharedAdvisorStatesForTests();
  });
});
