import { describe, expect, it } from 'vitest';
import { collectNewKillmailIds, extractKillPosition, shouldSendDigestHeartbeat } from '../../src/eve-board/monitor.js';
import type { RouteThreatDigest } from '../../src/eve-board/types.js';

describe('eve-board monitor', () => {
  it('deduplicates killmails across polling cycles', () => {
    const seen = new Set<number>([1001]);

    const firstWave = collectNewKillmailIds(seen, [
      { killmail_id: 1001 },
      { killmail_id: 1002 },
      { killmail_id: 1002 },
      { killmail_id: 1003 },
    ]);

    expect([...firstWave]).toEqual([1002, 1003]);
    expect([...seen]).toEqual([1001, 1002, 1003]);

    const secondWave = collectNewKillmailIds(seen, [
      { killmail_id: 1002 },
      { killmail_id: 1004 },
    ]);

    expect([...secondWave]).toEqual([1004]);
    expect([...seen]).toEqual([1001, 1002, 1003, 1004]);
  });

  it('extracts killmail positions from EVE-KILL payloads for gate attribution', () => {
    expect(extractKillPosition({
      killmail_id: 1,
      x: 10,
      y: 20,
      z: 30,
    })).toEqual({ x: 10, y: 20, z: 30 });

    expect(extractKillPosition({
      killmail_id: 2,
      position: { x: 40, y: 50, z: 60 },
    })).toEqual({ x: 40, y: 50, z: 60 });

    expect(extractKillPosition({ killmail_id: 3 })).toBeNull();
  });

  it('re-sends actionable digest after heartbeat interval even without new deltas', () => {
    const digest: RouteThreatDigest = {
      timestamp: '2026-04-02T15:00:00Z',
      pilotSystem: 'Dodixie',
      pilotSystemIdx: 0,
      totalRouteSystems: 15,
      origin: 'Dodixie',
      destination: 'Jita',
      overallThreat: 'MEDIUM',
      summary: 'medium route',
      tactical: {
        state: 'WARM',
        confidence: 0.62,
        headline: 'Маршрут тёплый: есть фоновые угрозы без явного кемпа.',
        reasons: ['фоновые PvP-точки на трассе'],
        windowOpen: false,
        zoneRisk: {
          start: 'LOW',
          transit: 'MEDIUM',
          destination: 'LOW',
          rear: 'LOW',
        },
      },
      systemsAhead: [],
      systemsBehind: [],
    };

    expect(shouldSendDigestHeartbeat(Date.now() - 7 * 60_000, digest, 0)).toBe(true);
    expect(shouldSendDigestHeartbeat(Date.now() - 5 * 60_000, digest, 0)).toBe(false);
  });
});
