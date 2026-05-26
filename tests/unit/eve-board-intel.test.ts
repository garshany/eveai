import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRouteThreatDigest,
  formatThreatDigest,
} from '../../src/eve-board/analytics.js';
import {
  detectPursuit,
  generateRouteIntelSummary,
  formatIntelMessage,
  shouldUseLlmIntel,
} from '../../src/eve-board/advisor.js';
import type {
  RouteThreatDigest,
  ShipAssessment,
  SystemThreatDigest,
} from '../../src/eve-board/types.js';

vi.mock('../../src/agent/native-responses.js', () => ({
  createNativeResponse: vi.fn(async () => {
    throw new Error('LLM unavailable');
  }),
  toNativeMessage: (text: string) => ({ role: 'user', content: text }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('eve-board travel intel', () => {
  it('formats a deterministic quiet digest around the current route position', () => {
    const ahead = makeSystemDigest({
      systemId: 30002660,
      systemName: 'Nisuwa',
      jumpsFromPilot: 1,
      threatLevel: 'LOW',
    });
    const behind = makeSystemDigest({
      systemId: 30002659,
      systemName: 'Dodixie',
      jumpsFromPilot: -1,
      threatLevel: 'LOW',
    });

    const digest = buildRouteThreatDigest(
      'Jita',
      1,
      3,
      'Dodixie',
      'Perimeter',
      [ahead],
      [behind],
    );

    const rendered = formatThreatDigest(digest);

    expect(digest.overallThreat).toBe('LOW');
    expect(digest.summary).toContain('Маршрут безопасен');
    expect(rendered).toContain('Dodixie → Perimeter');
    expect(rendered).toContain('Вы в: Jita (2/3)');
    expect(rendered).toContain('Позади (1 система)');
    expect(rendered).toContain('Впереди (1 система)');
  });

  it('falls back to a stable travel-assistant message when the LLM is unavailable', async () => {
    const digest = buildQuietDigest();
    const ship: ShipAssessment = {
      shipTypeId: 123,
      shipName: 'Gila',
      ehp: 13290,
      alignTime: 8.78,
      warpSpeed: 3.0,
      shipClass: 'cruiser',
      isHighValueTarget: false,
      survivalChance: 'UNLIKELY',
    };

    const summary = await generateRouteIntelSummary(
      digest,
      ship,
      null,
      [],
      {
        routeSystems: [30002659, 30002660, 30000142],
        originId: 30002659,
        destinationId: 30000142,
        currentSystemId: 30002660,
      },
    );

    expect(shouldUseLlmIntel(digest, null, [])).toBe(false);
    expect(summary.recommendation).toBe('PROCEED');
    expect(summary.advice).toContain('Сейчас:');
    expect(summary.advice).toContain('Впереди:');
    expect(summary.advice).toContain('Действие:');
    expect(summary.advice).toContain('свежих PvP-угроз не видно');
    expect(formatIntelMessage(summary, { digest, ship, gankerIntel: [] })).toContain('🛰️ ESP | 🟢 ВПЕРЁД');
  });

  it('dedupes killmail ids across poll cycles', async () => {
    const { collectNewKillmailIds } = await import('../../src/eve-board/monitor.js');
    const seen = new Set<number>();

    expect([...collectNewKillmailIds(seen, [{ killmail_id: 101 }, { killmail_id: 102 }])]).toEqual([101, 102]);
    expect([...collectNewKillmailIds(seen, [{ killmail_id: 102 }, { killmail_id: 101 }])]).toEqual([]);
    expect([...collectNewKillmailIds(seen, [{ killmail_id: 102 }, { killmail_id: 103 }])]).toEqual([103]);
  });

  it('detects pursuit when kills behind the pilot move closer over time', () => {
    const now = Date.now();
    const pursuit = detectPursuit(
      [30002659, 30002660, 30002661, 30000142],
      3,
      [
        { systemId: 30002659, time: new Date(now - 9 * 60_000).toISOString() },
        { systemId: 30002660, time: new Date(now - 6 * 60_000).toISOString() },
        { systemId: 30002661, time: new Date(now - 3 * 60_000).toISOString() },
      ],
    );

    expect(pursuit).not.toBeNull();
    expect(pursuit?.approachingPilot).toBe(true);
    expect(pursuit?.systemIds).toEqual([30002659, 30002660, 30002661]);
  });
});

function makeSystemDigest(input: {
  systemId: number;
  systemName: string;
  jumpsFromPilot: number;
  threatLevel: SystemThreatDigest['threatLevel'];
}): SystemThreatDigest {
  return {
    systemId: input.systemId,
    systemName: input.systemName,
    systemSec: 0.9,
    jumpsFromPilot: input.jumpsFromPilot,
    threatLevel: input.threatLevel,
    reason: 'тихо',
    killVelocity: 0,
    activeCamp: false,
    latestKillMinutes: null,
    jumpSpike: null,
    gateKills: [],
    gankerCount: 0,
    recentKills: [],
  };
}

function buildQuietDigest(): RouteThreatDigest {
  const current = makeSystemDigest({
    systemId: 30002660,
    systemName: 'Midpoint',
    jumpsFromPilot: 0,
    threatLevel: 'LOW',
  });
  const ahead = makeSystemDigest({
    systemId: 30000142,
    systemName: 'Jita',
    jumpsFromPilot: 1,
    threatLevel: 'LOW',
  });
  const behind = makeSystemDigest({
    systemId: 30002659,
    systemName: 'Dodixie',
    jumpsFromPilot: -1,
    threatLevel: 'LOW',
  });

  return buildRouteThreatDigest(
    'Midpoint',
    1,
    3,
    'Dodixie',
    'Jita',
    [current, ahead],
    [behind],
  );
}
