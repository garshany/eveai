import { describe, expect, it } from 'vitest';
import { focusTargetFor } from '../../web/src/components/map/camera.js';
import {
  mergeAdvisoryMessages,
  mergeSystemKills,
  overlayLiveKills,
  unseenKills,
} from '../../web/src/components/map/live-merge.js';
import { freshnessLayersForView } from '../../web/src/components/map/labels.js';
import { flashProgress, FLASH_MS } from '../../web/src/components/map/renderer.js';
import { centreOn } from '../../web/src/components/map/universe-view.js';
import { isStreamStale } from '../../web/src/components/map/live-watchdog.js';
import type { MapKillEvent, MapLayerFreshness, PerimeterMessage, UniverseActivity } from '../../web/src/types.js';

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

describe('overlayLiveKills (whole-map view)', () => {
  const NOW = Date.parse('2026-09-24T12:00:00Z');
  const snapshot = (): UniverseActivity => ({
    at: new Date(NOW - 10_000).toISOString(),
    windowMinutes: 60,
    systemIds: [10],
    kills1h: [2],
    kills15m: [1],
    npcKills1h: [0],
    valueDestroyed1h: [100],
    gateKills1h: [2],
    bands: ['hostile'],
    baselineJumps: {},
    totals: { activeSystems: 1, kills1h: 2, campedSystems: 1 },
  });

  it('adds a streamed kill received after the poll, once, and lights a quiet system', () => {
    const base = snapshot();
    const fresh = kill(7, 20, NOW - 30_000);
    const merged = overlayLiveKills(base, [
      { kill: fresh, receivedAtMs: NOW - 1_000 },
      { kill: fresh, receivedAtMs: NOW - 500 },
    ], NOW - 5_000, NOW);
    const index = merged.systemIds.indexOf(20);
    expect(index).toBe(1);
    expect(merged.kills1h[index]).toBe(1);
    expect(merged.kills15m[index]).toBe(1);
    expect(merged.bands[index]).toBe('watch');
    expect(merged.totals).toEqual({ activeSystems: 2, kills1h: 3, campedSystems: 1 });
    // The polled snapshot itself is not mutated.
    expect(base.systemIds).toEqual([10]);
  });

  it('never lowers a band and bumps an already active system', () => {
    const merged = overlayLiveKills(snapshot(), [{ kill: kill(8, 10, NOW - 1_000), receivedAtMs: NOW }], NOW - 5_000, NOW);
    expect(merged.kills1h[0]).toBe(3);
    expect(merged.bands[0]).toBe('hostile');
  });

  it('skips kills the snapshot already covers and keeps the same object', () => {
    const base = snapshot();
    expect(overlayLiveKills(base, [{ kill: kill(9, 10, NOW - 60_000), receivedAtMs: NOW - 6_000 }], NOW - 5_000, NOW))
      .toBe(base);
  });

  it('counts NPC kills as ratting, not danger', () => {
    const npc = { ...kill(11, 30, NOW - 1_000), isNpc: true };
    const merged = overlayLiveKills(snapshot(), [{ kill: npc, receivedAtMs: NOW }], NOW - 5_000, NOW);
    const index = merged.systemIds.indexOf(30);
    expect(merged.npcKills1h[index]).toBe(1);
    expect(merged.kills1h[index]).toBe(0);
    expect(merged.bands[index]).toBe('calm');
    expect(merged.totals.kills1h).toBe(2);
  });
});

describe('whole-map kill flashes', () => {
  it('burns out after the shared flash duration', () => {
    const flash = { systemId: 1, startedAt: 1_000, value: 0 };
    expect(flashProgress(flash, 1_000, false)).toBe(0);
    expect(flashProgress(flash, 1_000 + FLASH_MS / 2, false)).toBeCloseTo(0.5);
    expect(flashProgress(flash, 1_000 + FLASH_MS + 1, false)).toBeNull();
    expect(flashProgress(flash, 1_200, true)).toBe(0.5);
  });
});

describe('freshnessLayersForView', () => {
  const layer = (name: string, status: MapLayerFreshness['status']): MapLayerFreshness =>
    ({ layer: name, status, retrievedAt: null, error: null });

  it('shows the cluster kill-feed freshness on the whole-map view, even without a bubble', () => {
    expect(freshnessLayersForView(null, layer('kills', 'cached'), true)).toEqual([layer('kills', 'cached')]);
  });

  it('replaces the bubble kill layer on the whole-map view and keeps the others', () => {
    const result = freshnessLayersForView(
      [layer('kills', 'live'), layer('esi_kills', 'hourly')],
      layer('kills', 'unavailable'),
      true,
    );
    expect(result).toEqual([layer('kills', 'unavailable'), layer('esi_kills', 'hourly')]);
  });

  it('leaves the bubble view untouched', () => {
    const bubble = [layer('kills', 'live')];
    expect(freshnessLayersForView(bubble, layer('kills', 'cached'), false)).toEqual(bubble);
    expect(freshnessLayersForView(null, null, false)).toBeNull();
  });
});
