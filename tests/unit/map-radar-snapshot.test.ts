import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatRadarSnapshot,
  getRadarSnapshot,
  recordRadarAdvisory,
  recordRadarBubble,
  recordRadarLocation,
  resetRadarSnapshotsForTests,
} from '../../src/eve-map/radar-snapshot.js';
import type { BubblePayload } from '../../src/eve-map/bubble.js';
import type { Advisory } from '../../src/eve-map/advisor.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const CHAR = 90000001;

function bubble(): BubblePayload {
  const sys = (systemId: number, name: string, jumps: number, score: number, band: string, kills15m = 0, kills1h = 0) => ({
    systemId, name, jumps, security: 0.5,
    activity: { kills15m, kills1h },
    gateCamps: score > 0.5 ? [{}] : [],
    danger: { systemId, score, band, terms: [] },
  });
  return {
    originId: 1, radius: 3,
    systems: [sys(1, 'Sivala', 0, 0, 'calm'), sys(2, 'Uedama', 1, 0.82, 'hot', 3, 7), sys(3, 'Niarja', 2, 0.3, 'warn', 0, 2)],
    verdict: { score: 0.6, band: 'warn', worstSystemId: 2 },
    pilotShip: { shipName: 'Iteron Mark V' },
    recentKills: [],
    builtAt: new Date(NOW).toISOString(),
  } as unknown as BubblePayload;
}

const advisory = (n: number): Advisory => ({
  rule: 'threat_rise', severity: 'warn', text: { ru: `тревога ${n}`, en: `alarm ${n}` },
  systemId: 2, killmailId: null, repeats: 0, stateKey: `k${n}`, at: new Date(NOW).toISOString(),
});

beforeEach(() => resetRadarSnapshotsForTests());

describe('perimeter radar snapshot for the chat agent', () => {
  it('summarises position, bubble and the latest alarms', () => {
    recordRadarLocation({
      characterId: CHAR, solarSystemId: 1, stationId: null, structureId: null,
      shipTypeId: 657, shipName: 'Moving Van', online: true, at: new Date(NOW).toISOString(),
    }, NOW);
    recordRadarBubble(CHAR, bubble(), NOW);
    for (let n = 1; n <= 7; n += 1) recordRadarAdvisory(CHAR, advisory(n), `тревога ${n}`, NOW);

    const text = formatRadarSnapshot(CHAR, NOW + 2_000)!;
    expect(text).toContain('updated 2s ago');
    expect(text).toContain('- Pilot: Sivala (system_id=1), in space, online, hull Iteron Mark V.');
    expect(text).toContain('verdict warn (60%), worst Uedama');
    expect(text).toContain('Uedama: 1 jumps, sec 0.5, hot, kills 15m/1h 3/7, gate camp kills 1');
    // Only the newest five alarms are kept.
    expect(text).not.toContain('тревога 2\n');
    expect(text).toContain('тревога 3');
    expect(text).toContain('тревога 7');
  });

  it('forgets a stale radar (map closed) and says nothing for unknown pilots', () => {
    recordRadarBubble(CHAR, bubble(), NOW);
    expect(formatRadarSnapshot(CHAR, NOW + 4 * 60_000)).not.toBeNull();
    expect(getRadarSnapshot(CHAR, NOW + 6 * 60_000)).toBeNull();
    expect(formatRadarSnapshot(CHAR, NOW + 6 * 60_000)).toBeNull();
    expect(formatRadarSnapshot(12345, NOW)).toBeNull();
  });
});

describe('the Perimeter chat agent reads the radar', () => {
  it('adds the radar snapshot to a Perimeter turn only', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    recordRadarBubble(CHAR, bubble(), NOW);
    const perimeter = __test__.buildRuntimeLiveSummary('perimeter', CHAR, 'Ship: Iteron', NOW + 1_000)!;
    expect(perimeter).toContain('Ship: Iteron');
    expect(perimeter).toContain('Perimeter radar (live map open');
    expect(perimeter).toContain('worst Uedama');
    // The workspace assistant does not get the flight picture.
    expect(__test__.buildRuntimeLiveSummary('full', CHAR, 'Ship: Iteron', NOW)).toBe('Ship: Iteron');
    // No map open, nothing extra; nothing at all → null.
    expect(__test__.buildRuntimeLiveSummary('perimeter', 777, null, NOW)).toBeNull();
    expect(__test__.buildRuntimeLiveSummary('perimeter', null, null, NOW)).toBeNull();
  });
});
