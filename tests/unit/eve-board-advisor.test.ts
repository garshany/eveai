import { describe, expect, it } from 'vitest';
import { formatIntelMessage, shouldUseLlmIntel } from '../../src/eve-board/advisor.js';
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
    expect(text).toContain('Сейчас: Dodixie');
    expect(text).toContain('Впереди: Uedama');
    expect(text).toContain('Действие: можно выходить');
    expect(text).not.toContain('Маршрут относительно безопасен. Будьте внимательны.');
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
});
