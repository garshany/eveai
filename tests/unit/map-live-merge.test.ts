import { describe, expect, it } from 'vitest';
import { focusTargetFor } from '../../web/src/components/map/camera.js';
import { mergeAdvisoryMessages, mergeSystemKills, unseenKills } from '../../web/src/components/map/live-merge.js';
import { centreOn } from '../../web/src/components/map/universe-view.js';
import { isStreamStale } from '../../web/src/components/map/live-watchdog.js';
import type { MapKillEvent, PerimeterMessage } from '../../web/src/types.js';

function message(id: number): PerimeterMessage {
  return { id, role: 'assistant', content: `m${id}`, createdAt: '2026-09-24T00:00:00Z', meta: null };
}

function kill(killmailId: number, systemId: number, killmailTimeMs: number): MapKillEvent {
  return {
    killmailId, systemId, regionId: null, killmailTime: null, killmailTimeMs, totalValue: 1, attackerCount: 1,
    isNpc: false, isSolo: true, victimShipTypeId: null, victimShipName: null, victimShipGroupName: null,
    victimCharacterId: null, victimCharacterName: null, victimCorporationName: null, finalBlowCharacterId: null,
    finalBlowCharacterName: null, finalBlowShipTypeId: null, finalBlowShipName: null, position: null,
  };
}

describe('mergeAdvisoryMessages', () => {
  it('appends only unseen advisories, once each, even when a batch repeats one', () => {
    const previous = [message(1), message(2)];
    const merged = mergeAdvisoryMessages(previous, [message(2), message(3), message(3), message(4)], 0);
    expect(merged.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
  });

  it('returns the same array when nothing is new so the chat does not re-render', () => {
    const previous = [message(1)];
    expect(mergeAdvisoryMessages(previous, [message(1)], 0)).toBe(previous);
  });

  it('keeps advisories the pilot cleared out of the panel', () => {
    expect(mergeAdvisoryMessages([], [message(5), message(6)], 5).map((entry) => entry.id)).toEqual([6]);
  });
});

describe('mergeSystemKills', () => {
  it('puts a fresh kill in the inspected system on top, without duplicates', () => {
    const existing = [kill(1, 10, 100)];
    const merged = mergeSystemKills(existing, [kill(2, 10, 200), kill(2, 10, 200), kill(1, 10, 100)], 10);
    expect(merged.map((entry) => entry.killmailId)).toEqual([2, 1]);
  });

  it('ignores kills in other systems and keeps the array identity when nothing changes', () => {
    const existing = [kill(1, 10, 100)];
    expect(mergeSystemKills(existing, [kill(3, 11, 300)], 10)).toBe(existing);
  });

  it('caps the list at the newest entries', () => {
    const existing = [kill(1, 10, 100), kill(2, 10, 50)];
    expect(mergeSystemKills(existing, [kill(3, 10, 300)], 10, 2).map((entry) => entry.killmailId)).toEqual([3, 1]);
  });
});

describe('unseenKills', () => {
  it('returns each kill not yet seen exactly once', () => {
    const fresh = unseenKills([kill(1, 10, 1), kill(2, 10, 2), kill(2, 10, 2)], new Set([1]));
    expect(fresh.map((entry) => entry.killmailId)).toEqual([2]);
  });
});

describe('focusTargetFor', () => {
  it('centres the requested system and never zooms out to do it', () => {
    expect(focusTargetFor({ width: 800, height: 600, point: { x: 100, y: -50 }, k: 1.1 }))
      .toEqual({ k: 1.1, x: 400 - 110, y: 300 + 55 });
  });

  it('zooms in to a readable scale from far out', () => {
    expect(focusTargetFor({ width: 800, height: 600, point: { x: 0, y: 0 }, k: 0.2 })?.k).toBe(0.8);
  });

  it('refuses to move without a canvas or a position', () => {
    expect(focusTargetFor({ width: 0, height: 600, point: { x: 0, y: 0 }, k: 1 })).toBeNull();
    expect(focusTargetFor({ width: 800, height: 600, point: null, k: 1 })).toBeNull();
  });
});

describe('centreOn (whole map)', () => {
  it('puts the system in the middle of the view, zoomed in far enough for labels', () => {
    const view = centreOn({ x: 0, y: 0, k: 1 }, 1, 10, 20, 800, 600);
    expect(view.k).toBeGreaterThanOrEqual(6);
    expect(10 * view.k + view.x).toBeCloseTo(400);
    expect(20 * view.k + view.y).toBeCloseTo(300);
  });

  it('keeps a closer zoom the pilot already chose', () => {
    expect(centreOn({ x: 0, y: 0, k: 50 }, 1, 0, 0, 800, 600).k).toBe(50);
  });
});

describe('isStreamStale', () => {
  const base = { now: 100_000, sawLocation: true, pollSeconds: 5 };

  it('treats a stream silent for longer than the window as stale once located', () => {
    expect(isStreamStale({ ...base, lastEventAt: 100_000 - 44_000 })).toBe(false);
    expect(isStreamStale({ ...base, lastEventAt: 100_000 - 46_000 })).toBe(true);
  });

  it('waits longer before the first location, while ESI backoff can reach a minute', () => {
    expect(isStreamStale({ ...base, sawLocation: false, lastEventAt: 100_000 - 70_000 })).toBe(false);
    expect(isStreamStale({ ...base, sawLocation: false, lastEventAt: 100_000 - 91_000 })).toBe(true);
  });

  it('never fires faster than three poll intervals on a slow-polling server', () => {
    expect(isStreamStale({ ...base, pollSeconds: 30, lastEventAt: 100_000 - 80_000 })).toBe(false);
    expect(isStreamStale({ ...base, pollSeconds: 30, lastEventAt: 100_000 - 91_000 })).toBe(true);
  });
});
