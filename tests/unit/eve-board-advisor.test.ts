import { describe, expect, it } from 'vitest';
import { buildRouteTacticalAssessment, formatIntelMessage, shouldUseLlmIntel } from '../../src/eve-board/advisor.js';
import type { RouteIntelSummary, RouteThreatDigest, ShipAssessment, SystemThreatDigest } from '../../src/eve-board/types.js';
import type { GankerIntel } from '../../src/eve-board/monitor.js';

function makeSystemDigest(overrides: Partial<SystemThreatDigest>): SystemThreatDigest {
  return {
    systemId: 30000142,
    systemName: 'Jita',
    systemSec: 0.9,
    jumpsFromPilot: 0,
    threatLevel: 'LOW',
    reason: 'тихо',
    killVelocity: 0,
    jumpSpike: null,
    gateKills: [],
    gankerCount: 0,
    recentKills: [],
    ...overrides,
  };
}

function makeDigest(overrides: Partial<RouteThreatDigest>): RouteThreatDigest {
  return {
    timestamp: '2026-04-02T10:45:00Z',
    pilotSystem: 'Dodixie',
    pilotSystemIdx: 0,
    totalRouteSystems: 3,
    origin: 'Dodixie',
    destination: 'Jita',
    systemsAhead: [
      makeSystemDigest({
        systemId: 30002659,
        systemName: 'Dodixie',
        jumpsFromPilot: 0,
        reason: 'единичные киллы 20 мин назад',
        recentKills: [{
          time: '10:25',
          ageMinutes: 20,
          victimShip: 'Capsule',
          victimName: 'Pilot A',
          attackerShip: '?',
          attackerName: 'Pilot B',
          attackerCount: 1,
          valueMISK: 0,
          solo: true,
        }],
      }),
      makeSystemDigest({
        systemId: 30002660,
        systemName: 'Uedama',
        jumpsFromPilot: 1,
      }),
      makeSystemDigest({
        systemId: 30000142,
        systemName: 'Jita',
        jumpsFromPilot: 2,
      }),
    ],
    systemsBehind: [],
    overallThreat: 'LOW',
    summary: 'тихо',
    tactical: {
      state: 'CLEAR',
      confidence: 0.45,
      headline: 'Маршрут тихий, явных тактических сигналов нет.',
      reasons: ['явных триггеров не найдено'],
      windowOpen: false,
      zoneRisk: {
        start: 'LOW',
        transit: 'LOW',
        destination: 'LOW',
        rear: 'LOW',
      },
    },
    ...overrides,
  };
}

const ship: ShipAssessment = {
  shipTypeId: 17715,
  shipName: 'Gila',
  ehp: 13290,
  alignTime: 8.78,
  warpSpeed: 3,
  shipClass: 'cruiser',
  isHighValueTarget: false,
  survivalChance: 'UNLIKELY',
};

describe('eve-board advisor', () => {
  it('formats ESP output as a stable operational digest', () => {
    const digest = makeDigest({});
    const summary: RouteIntelSummary = {
      timestamp: '2026-04-02T10:45:00Z',
      recommendation: 'PROCEED',
      advice: 'Маршрут относительно безопасен. Будьте внимательны.',
      factors: ['тихий маршрут'],
      pursuit: null,
    };

    const text = formatIntelMessage(summary, { digest, ship, gankerIntel: [] });

    expect(text).toContain('ESP | 🟢 ВПЕРЁД');
    expect(text).toContain('Состояние:');
    expect(text).toContain('Окно:');
    expect(text).toContain('Сейчас: Dodixie');
    expect(text).toContain('Впереди: Uedama');
    expect(text).toContain('Действие: можно выходить');
    expect(text).not.toContain('Маршрут относительно безопасен. Будьте внимательны.');
  });

  it('builds a tactical assessment for hot starts and gate-camp style activity', () => {
    const digest = makeDigest({
      overallThreat: 'MEDIUM',
      systemsAhead: [
        makeSystemDigest({
          systemId: 30002659,
          systemName: 'Dodixie',
          jumpsFromPilot: 0,
          threatLevel: 'MEDIUM',
          gateKills: [{
            systemId: 30002659,
            systemName: 'Dodixie',
            stargateId: 50000001,
            connectedSystemName: 'Uedama',
            killCount: 3,
            recentKills: 2,
          }],
        }),
        makeSystemDigest({
          systemId: 30002660,
          systemName: 'Uedama',
          jumpsFromPilot: 1,
        }),
        makeSystemDigest({
          systemId: 30000142,
          systemName: 'Jita',
          jumpsFromPilot: 2,
        }),
      ],
    });

    const tactical = buildRouteTacticalAssessment(digest, null, []);

    expect(tactical.state).toBe('CAMP_LIKELY');
    expect(tactical.startRisk).toBe('MEDIUM');
    expect(tactical.window).toBe('CLOSED');
    expect(tactical.summary).toContain('вероятен кемп');
  });

  it('marks destination-local heat separately from transit risk', () => {
    const digest = makeDigest({
      overallThreat: 'MEDIUM',
      systemsAhead: [
        makeSystemDigest({
          systemId: 30002659,
          systemName: 'Dodixie',
          jumpsFromPilot: 0,
        }),
        makeSystemDigest({
          systemId: 30002660,
          systemName: 'Uedama',
          jumpsFromPilot: 1,
          threatLevel: 'LOW',
        }),
        makeSystemDigest({
          systemId: 30000142,
          systemName: 'Jita',
          jumpsFromPilot: 2,
          threatLevel: 'MEDIUM',
          reason: 'локальная активность на входе',
        }),
      ],
    });

    const tactical = buildRouteTacticalAssessment(digest, null, []);

    expect(tactical.state).toBe('DESTINATION_HOT');
    expect(tactical.transitRisk).toBe('LOW');
    expect(tactical.destinationRisk).toBe('MEDIUM');
  });

  it('uses LLM only for actionable route states', () => {
    const quietDigest = makeDigest({});
    const highAheadDigest = makeDigest({
      overallThreat: 'HIGH',
      systemsAhead: [
        makeSystemDigest({ systemId: 30002659, systemName: 'Dodixie', jumpsFromPilot: 0 }),
        makeSystemDigest({
          systemId: 30002660,
          systemName: 'Uedama',
          jumpsFromPilot: 1,
          threatLevel: 'HIGH',
          reason: 'активный ганк-флот',
        }),
      ],
    });

    const gankers: GankerIntel[] = [{
      characterId: 42,
      characterName: 'Osmon Queen',
      shipName: 'Tornado',
      systems: [{ systemId: 30002660, systemName: 'Uedama', lastSeen: '2026-04-02T10:40:00Z', killCount: 3 }],
      totalKills: 3,
      lastSeenMinutesAgo: 5,
      isMoving: false,
    }];

    expect(shouldUseLlmIntel(quietDigest, null, [])).toBe(false);
    expect(shouldUseLlmIntel(highAheadDigest, null, gankers)).toBe(true);
  });

  it('treats fresh gate activity near the pilot as actionable intel', () => {
    const gateDigest = makeDigest({
      systemsAhead: [
        makeSystemDigest({
          systemId: 30002659,
          systemName: 'Dodixie',
          jumpsFromPilot: 0,
          gateKills: [{
            systemId: 30002659,
            systemName: 'Dodixie',
            stargateId: 50000001,
            connectedSystemName: 'Jita',
            killCount: 2,
            recentKills: 1,
          }],
        }),
        makeSystemDigest({
          systemId: 30002660,
          systemName: 'Uedama',
          jumpsFromPilot: 1,
        }),
      ],
    });

    expect(shouldUseLlmIntel(gateDigest, null, [])).toBe(true);
  });
});
