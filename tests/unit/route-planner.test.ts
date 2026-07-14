import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const callEsiOperationMock = vi.fn();
const getLinkedCharacterMock = vi.fn();
const {
  buildRouteThreatSnapshotMock,
  generateBriefingFromSnapshotMock,
  startRouteMonitorMock,
  findBestTheraShortcutMock,
  subscribeFeedMock,
  feedCaptureHarness,
} = vi.hoisted(() => {
  let listener: ((event: unknown) => void | Promise<void>) | null = null;
  const unsubscribe = vi.fn();
  return {
    buildRouteThreatSnapshotMock: vi.fn(),
    generateBriefingFromSnapshotMock: vi.fn().mockResolvedValue(''),
    startRouteMonitorMock: vi.fn(),
    findBestTheraShortcutMock: vi.fn(),
    subscribeFeedMock: vi.fn((next: (event: unknown) => void | Promise<void>) => {
      listener = next;
      return unsubscribe;
    }),
    feedCaptureHarness: {
      begin: (event: unknown) => {
        if (!listener) throw new Error('feed capture listener is not registered');
        return Promise.resolve(listener(event));
      },
      reset: () => {
        listener = null;
        unsubscribe.mockClear();
      },
      unsubscribe,
    },
  };
});

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

vi.mock('../../src/eve/sso.js', () => ({
  getLinkedCharacter: getLinkedCharacterMock,
}));

// Mock eve-board modules to prevent import issues
vi.mock('../../src/eve-board/monitor.js', () => ({
  startRouteMonitor: startRouteMonitorMock,
}));
vi.mock('../../src/eve-board/briefing.js', () => ({
  generateBriefing: vi.fn(),
  generateBriefingFromSnapshot: generateBriefingFromSnapshotMock,
}));
vi.mock('../../src/eve-board/route-snapshot.js', () => ({
  buildRouteThreatSnapshot: buildRouteThreatSnapshotMock,
}));
vi.mock('../../src/eve-kill/feed-poll.js', () => ({
  subscribeEveKillFeed: subscribeFeedMock,
}));
vi.mock('../../src/eve/thera-scout.js', () => ({
  findBestTheraShortcut: findBestTheraShortcutMock,
}));

let db: Database.Database;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  seedRouteData(db);

  getLinkedCharacterMock.mockReturnValue({ characterId: 2116626188 });
  generateBriefingFromSnapshotMock.mockResolvedValue('');
  findBestTheraShortcutMock.mockResolvedValue(null);
  startRouteMonitorMock.mockResolvedValue(true);
  buildRouteThreatSnapshotMock.mockResolvedValue(routeSnapshot([
    snapshotSystem(30002660, 'Midpoint', 0.5, 134200001),
  ]));
  feedCaptureHarness.reset();

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string, args: unknown) => {
    if (operation === 'get_route_origin_destination') {
      const flag = String((args as Record<string, unknown>).flag);
      if (flag === 'secure') {
        return { ok: true, status: 200, cached: false, headers: {}, data: [30002659, 30002660, 30000142] };
      }
      if (flag === 'shortest') {
        return { ok: true, status: 200, cached: false, headers: {}, data: [30002659, 30000142] };
      }
      return { ok: true, status: 200, cached: false, headers: {}, data: [30002659, 30002661, 30000142] };
    }

    if (operation === 'post_ui_autopilot_waypoint') {
      return { ok: true, status: 204, cached: false, headers: {}, data: null };
    }

    if (operation === 'get_killmails_killmail_id_killmail_hash') {
      return {
        ok: true, status: 200, cached: false, headers: {},
        data: {
          killmail_time: new Date().toISOString(),
          solar_system_id: 30002660,
          victim: { character_id: 9001, corporation_id: 9101, ship_type_id: 587 },
          attackers: [{ character_id: 9201, corporation_id: 9301, ship_type_id: 603, final_blow: true }],
        },
      };
    }

    if (operation === 'post_universe_names') {
      return {
        ok: true, status: 200, cached: false, headers: {},
        data: [
          { id: 9001, name: 'Victim One' },
          { id: 9101, name: 'Victim Corp' },
          { id: 9201, name: 'Attacker One' },
          { id: 9301, name: 'Attacker Corp' },
        ],
      };
    }

    return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
  });
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  vi.useRealTimers();
  db.close();
});

describe('route planner', () => {
  it('hands one shared baseline plus captured live events to the started monitor', async () => {
    const sharedBaseline = routeSnapshot([
      snapshotSystem(30002660, 'Midpoint', 0.5, 134200001),
    ]);
    const capturedEvent = {
      sequenceId: 700,
      killmail: {
        killmailId: 134200002,
        killmailTime: new Date().toISOString(),
        solarSystemId: 30002660,
        attackerCount: 1,
        isNpc: false,
        victim: { shipTypeId: 587 },
        attackers: [],
        items: [],
        siblings: [],
        sourceShape: 'feed',
      },
    };
    let capturedAcknowledgement: Promise<void> | null = null;
    let captureAcknowledged = false;
    buildRouteThreatSnapshotMock.mockImplementationOnce(async () => {
      capturedAcknowledgement = feedCaptureHarness.begin(capturedEvent);
      void capturedAcknowledgement.then(() => { captureAcknowledged = true; });
      return sharedBaseline;
    });
    startRouteMonitorMock.mockImplementationOnce(async () => {
      expect(captureAcknowledged).toBe(false);
      return true;
    });
    const { planRoute, setRouteMonitorSender } = await import('../../src/eve/route-planner.js');
    setRouteMonitorSender(async () => {});

    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(buildRouteThreatSnapshotMock).toHaveBeenCalledTimes(1);
    expect(subscribeFeedMock).toHaveBeenCalledTimes(1);
    expect(startRouteMonitorMock).toHaveBeenCalledTimes(1);
    expect(startRouteMonitorMock.mock.calls[0]?.[7]).toEqual({
      baseline: sharedBaseline,
      initialEvents: [capturedEvent],
    });
    await expect(capturedAcknowledgement).resolves.toBeUndefined();
    expect(captureAcknowledged).toBe(true);
    expect(feedCaptureHarness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('includes the selected Thera legs in the one shared baseline and live handoff', async () => {
    const entrySystemId = 30002662;
    const exitSystemId = 30002663;
    const hubSystemId = 31000005;
    const longRoute = [
      30002659,
      30002660,
      30002661,
      entrySystemId,
      30002664,
      30002665,
      30002666,
      30002667,
      30000142,
    ];
    findBestTheraShortcutMock.mockResolvedValue({
      hub_system: 'Thera',
      hub_system_id: hubSystemId,
      entry_system: 'Thera Entry',
      entry_system_id: entrySystemId,
      entry_class: 'lowsec',
      entry_region: 'The Forge',
      entry_jumps: 1,
      exit_system: 'Thera Exit',
      exit_system_id: exitSystemId,
      exit_class: 'lowsec',
      exit_region: 'The Forge',
      exit_jumps: 1,
      total_jumps: 4,
      direct_jumps: 8,
      saved_jumps: 4,
      max_ship_size: 'large',
      entry_remaining_hours: 6,
      exit_remaining_hours: 5,
      entry_wh_type: 'K162',
      exit_wh_type: 'K162',
    });
    callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string, args: unknown) => {
      const input = args as Record<string, unknown>;
      if (operation === 'get_route_origin_destination') {
        if (input.destination === entrySystemId) {
          return { ok: true, status: 200, cached: false, headers: {}, data: [30002659, entrySystemId] };
        }
        if (input.origin === exitSystemId) {
          return { ok: true, status: 200, cached: false, headers: {}, data: [exitSystemId, 30000142] };
        }
        return { ok: true, status: 200, cached: false, headers: {}, data: longRoute };
      }
      if (operation === 'post_ui_autopilot_waypoint') {
        return { ok: true, status: 204, cached: false, headers: {}, data: null };
      }
      return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
    });

    const sharedBaseline = {
      ...routeSnapshot([
        snapshotSystem(entrySystemId, 'Thera Entry', 0.2, 134200020),
        snapshotSystem(hubSystemId, 'Thera', -1, 134200022),
        snapshotSystem(exitSystemId, 'Thera Exit', 0.2, 134200021),
      ]),
      routeSystems: [...longRoute, hubSystemId, exitSystemId],
    };
    const capturedEvent = {
      sequenceId: 701,
      killmail: {
        killmailId: 134200023,
        killmailTime: new Date().toISOString(),
        solarSystemId: hubSystemId,
        attackerCount: 1,
        isNpc: false,
        victim: { shipTypeId: 587 },
        attackers: [],
        items: [],
        siblings: [],
        sourceShape: 'feed',
      },
    };
    let capturedAcknowledgement: Promise<void> | null = null;
    buildRouteThreatSnapshotMock.mockImplementationOnce(async () => {
      capturedAcknowledgement = feedCaptureHarness.begin(capturedEvent);
      return sharedBaseline;
    });

    const { planRoute, setRouteMonitorSender } = await import('../../src/eve/route-planner.js');
    setRouteMonitorSender(async () => {});
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'thera_shortcut',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.autopilot_mode).toBe('wh_shortcut');
    expect(buildRouteThreatSnapshotMock).toHaveBeenCalledTimes(1);
    expect(buildRouteThreatSnapshotMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      entrySystemId,
      hubSystemId,
      exitSystemId,
    ]));
    expect(startRouteMonitorMock).toHaveBeenCalledTimes(1);
    expect(startRouteMonitorMock.mock.calls[0]?.[3]).toEqual([
      30002659,
      entrySystemId,
      hubSystemId,
      exitSystemId,
      30000142,
    ]);
    expect(startRouteMonitorMock.mock.calls[0]?.[7]).toEqual({
      baseline: sharedBaseline,
      initialEvents: [capturedEvent],
    });
    await expect(capturedAcknowledgement).resolves.toBeUndefined();
    expect(feedCaptureHarness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('uses the shortest route consistently when a requested Thera shortcut is unavailable', async () => {
    const { planRoute, setRouteMonitorSender } = await import('../../src/eve/route-planner.js');
    setRouteMonitorSender(async () => {});

    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'thera_shortcut',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.autopilot_mode).toBe('exact_route');
    expect(result.formatted_summary).toContain('Выбран: shortest');
    const waypointCalls = callEsiOperationMock.mock.calls.filter(
      (call) => call[1] === 'post_ui_autopilot_waypoint',
    );
    expect(waypointCalls.map((call) => call[2])).toEqual([{
      destination_id: 30000142,
      clear_other_waypoints: true,
      add_to_beginning: false,
    }]);
    expect(generateBriefingFromSnapshotMock.mock.calls[0]?.[1]).toEqual([30002659, 30000142]);
    expect(startRouteMonitorMock.mock.calls[0]?.[3]).toEqual([30002659, 30000142]);
  });

  it('falls back to the full direct route when either Thera K-space leg is unavailable', async () => {
    const shortestRoute = [
      30002659,
      30002661,
      30002660,
      30002664,
      30002665,
      30002666,
      30002667,
      30002662,
      30000142,
    ];
    findBestTheraShortcutMock.mockResolvedValue({
      hub_system: 'Thera',
      hub_system_id: 31000005,
      entry_system: 'Thera Entry',
      entry_system_id: 30002662,
      entry_class: 'lowsec',
      entry_region: 'The Forge',
      entry_jumps: 1,
      exit_system: 'Thera Exit',
      exit_system_id: 30002663,
      exit_class: 'lowsec',
      exit_region: 'The Forge',
      exit_jumps: 1,
      total_jumps: 4,
      direct_jumps: 8,
      saved_jumps: 4,
      max_ship_size: 'large',
      entry_remaining_hours: 6,
      exit_remaining_hours: 5,
      found_at: '2026-07-13T12:00:00Z',
    });
    const originalEsiImplementation = callEsiOperationMock.getMockImplementation();
    callEsiOperationMock.mockImplementation(async (...call: unknown[]) => {
      if (call[1] === 'get_route_origin_destination') {
        const routeArgs = call[2] as Record<string, unknown>;
        if (routeArgs.origin === 30002659 && routeArgs.destination === 30002662) {
          return { ok: false, status: 404, error: 'entry leg unavailable' };
        }
        if (routeArgs.origin === 30002663 && routeArgs.destination === 30000142) {
          return { ok: true, status: 200, cached: false, headers: {}, data: [30002663, 30000142] };
        }
        if (routeArgs.origin === 30002659 && routeArgs.destination === 30000142) {
          if (routeArgs.flag === 'shortest') {
            return { ok: true, status: 200, cached: false, headers: {}, data: shortestRoute };
          }
          const alternate = routeArgs.flag === 'secure'
            ? [30002659, 30002660, 30002661, 30002664, 30002665, 30002666, 30002667, 30002662, 30000142]
            : [30002659, 30002662, 30002667, 30002666, 30002665, 30002664, 30002661, 30002660, 30000142];
          return { ok: true, status: 200, cached: false, headers: {}, data: alternate };
        }
      }
      if (!originalEsiImplementation) throw new Error('missing ESI test implementation');
      return await originalEsiImplementation(...call);
    });

    const { planRoute, setRouteMonitorSender } = await import('../../src/eve/route-planner.js');
    setRouteMonitorSender(async () => {});
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'thera_shortcut',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.autopilot_mode).toBe('exact_route');
    expect(result.formatted_summary).toContain('Выбран: shortest');
    expect(result.formatted_summary).not.toContain('Выбран: WH шорткат');
    expect(buildRouteThreatSnapshotMock.mock.calls[0]?.[1]).not.toContain(31000005);
    expect(startRouteMonitorMock.mock.calls[0]?.[3]).toEqual(shortestRoute);
  });

  it('returns a normal no-route result when every ESI route variant is unavailable', async () => {
    const originalEsiImplementation = callEsiOperationMock.getMockImplementation();
    callEsiOperationMock.mockImplementation(async (...call: unknown[]) => {
      if (call[1] === 'get_route_origin_destination') {
        return { ok: false, status: 404, error: 'No route found' };
      }
      if (!originalEsiImplementation) throw new Error('missing ESI test implementation');
      return await originalEsiImplementation(...call);
    });

    const { planRoute, setRouteMonitorSender } = await import('../../src/eve/route-planner.js');
    setRouteMonitorSender(async () => {});
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result).toMatchObject({
      ok: false,
      routes: [],
      autopilot_set: false,
      autopilot_mode: 'none',
      error: 'No ESI route is available between the requested systems.',
    });
    expect(result.formatted_summary).toContain('Маршруты не найдены');
    expect(buildRouteThreatSnapshotMock).not.toHaveBeenCalled();
    expect(subscribeFeedMock).not.toHaveBeenCalled();
    expect(startRouteMonitorMock).not.toHaveBeenCalled();
  });

  it('backpressures the durable feed instead of silently dropping a late handoff overflow', async () => {
    const originalEsiImplementation = callEsiOperationMock.getMockImplementation();
    let overflowRejected = false;
    let filled = false;
    const pendingAcknowledgements: Promise<void>[] = [];
    callEsiOperationMock.mockImplementation(async (...call: unknown[]) => {
      const operation = String(call[1]);
      if (operation === 'post_ui_autopilot_waypoint' && !filled) {
        filled = true;
        for (let index = 0; index <= 2_500; index += 1) {
          const acknowledgement = feedCaptureHarness.begin({
            sequenceId: 800 + index,
            killmail: {
              killmailId: 134300000 + index,
              killmailTime: new Date().toISOString(),
              solarSystemId: 30002660,
              attackerCount: 1,
              isNpc: false,
              victim: { shipTypeId: 587 },
              attackers: [],
              items: [],
              siblings: [],
              sourceShape: 'feed',
            },
          });
          if (index < 2_500) {
            pendingAcknowledgements.push(acknowledgement);
          } else {
            void acknowledgement.catch((error: unknown) => {
              overflowRejected = true;
              expect((error as Error).message).toContain('buffer reached its local cap');
            });
          }
        }
      }
      if (!originalEsiImplementation) throw new Error('missing ESI test implementation');
      return await originalEsiImplementation(...call);
    });

    const { planRoute, setRouteMonitorSender } = await import('../../src/eve/route-planner.js');
    setRouteMonitorSender(async () => {});
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(startRouteMonitorMock).toHaveBeenCalledTimes(1);
    expect(startRouteMonitorMock.mock.calls[0]?.[7]).toMatchObject({
      initialEvents: expect.arrayContaining([
        expect.objectContaining({ sequenceId: 800 }),
        expect.objectContaining({ sequenceId: 3_299 }),
      ]),
    });
    expect((startRouteMonitorMock.mock.calls[0]?.[7] as { initialEvents: unknown[] }).initialEvents).toHaveLength(2_500);
    await Promise.all(pendingAcknowledgements);
    await vi.waitFor(() => expect(overflowRejected).toBe(true));
    expect(feedCaptureHarness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects the captured listener acknowledgement when monitor handoff processing is not ready', async () => {
    const capturedEvent = {
      sequenceId: 750,
      killmail: {
        killmailId: 134200750,
        killmailTime: new Date().toISOString(),
        solarSystemId: 30002660,
        attackerCount: 1,
        isNpc: false,
        victim: { shipTypeId: 587 },
        attackers: [],
        items: [],
        siblings: [],
        sourceShape: 'feed',
      },
    };
    let capturedAcknowledgement: Promise<void> | null = null;
    buildRouteThreatSnapshotMock.mockImplementationOnce(async () => {
      capturedAcknowledgement = feedCaptureHarness.begin(capturedEvent);
      return routeSnapshot([]);
    });
    startRouteMonitorMock.mockResolvedValueOnce(false);

    const { planRoute, setRouteMonitorSender } = await import('../../src/eve/route-planner.js');
    setRouteMonitorSender(async () => {});
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    await expect(capturedAcknowledgement).rejects.toThrow('did not accept the captured feed handoff');
    expect(feedCaptureHarness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('fails closed instead of returning green zeroes when the route baseline is unavailable', async () => {
    buildRouteThreatSnapshotMock.mockResolvedValue({
      ...routeSnapshot([]),
      error: 'upstream timeout',
      requestCount: 0,
    });

    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.routes).toEqual([]);
    expect(result.autopilot_set).toBe(false);
    expect(result.error).toContain('upstream timeout');
    expect(result.formatted_summary).toContain('нельзя считать подтверждением безопасности');
    expect(result.formatted_summary).not.toContain('киллов/ч: 0');
    expect(callEsiOperationMock.mock.calls.some((call) => call[1] === 'post_ui_autopilot_waypoint')).toBe(false);
  });

  it('reads securityStatus from SDE when building route data', async () => {
    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: false,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.origin?.name).toBe('Dodixie');
    expect(result.origin?.sec).toBe(0.9);
    expect(result.destination?.name).toBe('Jita');
    expect(result.destination?.sec).toBe(0.9);
    expect(result.routes).toHaveLength(3);
    expect(result.routes[0].systems).toEqual(['Dodixie', 'Midpoint', 'Jita']);
    expect(result.routes[0].min_sec).toBe(0.5);
    expect(result.routes[0].safe_count).toBe(2);
    expect(result.routes[0].danger_systems).toHaveLength(1);
    expect(generateBriefingFromSnapshotMock.mock.calls[0]?.[2]?.[0]?.recentKills?.[0]).toMatchObject({
      attacker_count: 4,
      ship_group_name: 'Industrial',
      final_blow_character_id: 9201,
    });
    expect(result.formatted_summary).toContain('<b>Dodixie → Jita</b>');
    expect(result.formatted_summary).toContain('Выбран: secure');
    expect(result.formatted_summary).toContain('прыжков');
    expect(result.formatted_summary).toContain('secure');
    expect(result.formatted_summary).toContain('Ключевые точки');
    expect(result.formatted_summary).toContain('EVE-KILL срез:');
    expect(result.formatted_summary).not.toContain('<b>Опасные системы</b>');
  });

  it('can append the unified pre-flight brief even when autopilot is not enabled', async () => {
    generateBriefingFromSnapshotMock.mockResolvedValue('🛰️ Предполет | 🟡 ОСТОРОЖНО');

    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: false,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.autopilot_set).toBe(false);
    expect(result.formatted_summary).toContain('🛰️ Предполет | 🟡 ОСТОРОЖНО');
  });

  it('returns a compact route summary and appends the unified pre-flight brief', async () => {
    generateBriefingFromSnapshotMock.mockResolvedValue([
      '🛰️ Предполет | 🟢 ВЫХОДИ',
      'Маршрут: Dodixie → Jita (2 прыжков)',
      'Сейчас: Dodixie — локально тихо.',
      'Впереди: Midpoint через 1 прыжок — свежих PvP-угроз не видно.',
      'Действие: можно выходить.',
    ].join('\n'));

    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: true,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.autopilot_set).toBe(true);
    expect(result.autopilot_mode).toBe('exact_route');
    expect(result.formatted_summary).toContain('<b>Dodixie → Jita</b>');
    expect(result.formatted_summary).toContain('выставлен');
    expect(result.formatted_summary).toContain('Ключевые точки');
    expect(result.formatted_summary).toContain('EVE-KILL срез:');
    expect(result.formatted_summary).toContain('🛰️ Предполет | 🟢 ВЫХОДИ');
    expect(result.formatted_summary).toContain('Сейчас: Dodixie');
    expect(result.formatted_summary).not.toContain('<b>Опасные системы</b>');
    expect(result.formatted_summary).toContain('EVE-KILL</a>');
    expect(result.formatted_summary).not.toContain('<-');
    expect(result.formatted_summary).not.toContain('{"');
    expect(callEsiOperationMock).toHaveBeenCalledWith(
      db,
      'post_ui_autopilot_waypoint',
      {
        destination_id: 30002660,
        clear_other_waypoints: true,
        add_to_beginning: false,
      },
      { userId: 1, chatId: 1 },
    );
  });

  it('keeps the summary focused on the selected route instead of merged danger coverage', async () => {
    buildRouteThreatSnapshotMock.mockResolvedValue(routeSnapshot([
      snapshotSystem(30002659, 'Dodixie', 0.9, 134200010),
      snapshotSystem(30002660, 'Midpoint', 0.5, 134200011),
      snapshotSystem(30002661, 'Scout Gate', 0.1, 134200012),
    ]));

    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: false,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.formatted_summary).toContain('киллов/ч: 2');
    expect(result.formatted_summary).toContain('Ключевые точки');
    expect(result.formatted_summary).toContain('EVE-KILL срез:');
    expect(result.formatted_summary).toContain('Midpoint');
    expect(result.formatted_summary).not.toContain('Scout Gate');
    expect(result.formatted_summary).not.toContain('[insecure]');
  });

  it('labels bounded value enrichment with explicit killmail coverage', async () => {
    buildRouteThreatSnapshotMock.mockResolvedValue(routeSnapshot([{
      ...snapshotSystem(30002660, 'Midpoint', 0.5, 134200020),
      pvpKills: 20,
      valueResolvedKills: 1,
      totalValueM: 42,
    }]));

    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: false,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.routes.find((route) => route.flag === 'secure')).toMatchObject({
      total_kills_1h: 20,
      total_value_m: 42,
      value_resolved_kills: 1,
    });
    expect(result.formatted_summary).toContain('оценка потерь по выборке 1/20: 42M');
    expect(result.formatted_summary).not.toContain('20 PvP, 42M');
  });

  it('shows a clean EVE-KILL snapshot when the bounded one-hour search has no kills', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T16:24:00Z'));

    buildRouteThreatSnapshotMock.mockResolvedValue(routeSnapshot([]));

    const { planRoute } = await import('../../src/eve/route-planner.js');
    const result = await planRoute(
      db,
      {
        origin: 'current',
        destination: 'Jita',
        set_autopilot: false,
        prefer: 'secure',
      },
      { userId: 1, chatId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.formatted_summary).toContain('киллов/ч: 0');
    expect(result.formatted_summary).toContain('EVE-KILL срез: на выбранной трассе свежих killmail за последний час не видно.');
    expect(result.formatted_summary).not.toContain('Victim One');
  });
});

function snapshotSystem(systemId: number, name: string, sec: number, killmailId: number) {
  const killmailTime = new Date().toISOString();
  return {
    systemId,
    routeIndex: 0,
    name,
    sec,
    pvpKills: 1,
    npcKills: 0,
    totalValueM: 42,
    valueResolvedKills: 1,
    recentKills: [{
      killmail_id: killmailId,
      killmail_time: killmailTime,
      total_value: 42_000_000,
      attacker_count: 4,
      is_npc: false,
      is_solo: false,
      ship_type_id: 587,
      ship_name: 'Victim Ship',
      ship_group_name: 'Industrial',
      victim_character_id: 9001,
      victim_character_name: 'Victim One',
      final_blow_character_id: 9201,
      final_blow_character_name: 'Attacker One',
      final_blow_ship_name: 'Attacker Ship',
      eve_kill_url: `https://eve-kill.com/kill/${killmailId}`,
      time_msk: killmailTime,
    }],
    gateKills: [],
  };
}

function routeSnapshot(systems: ReturnType<typeof snapshotSystem>[]) {
  return {
    routeSystems: [30002659, 30002660, 30002661, 30000142],
    systems,
    jumpMap: new Map<number, number>(),
    totalKills: systems.length,
    totalValueM: systems.length * 42,
    truncated: false,
    requestCount: 1,
    error: null,
    scannedAt: new Date().toISOString(),
  };
}

function seedRouteData(db: Database.Database): void {
  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
    10000002,
    'The Forge',
    JSON.stringify({ region_id: 10000002, name: 'The Forge' }),
  );
  db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
    20000389,
    'Kimotoro',
    10000002,
    JSON.stringify({ constellation_id: 20000389, name: 'Kimotoro', region_id: 10000002 }),
  );

  insertSystem(db, 30002659, 'Dodixie', 20000389, 0.9);
  insertSystem(db, 30002660, 'Midpoint', 20000389, 0.5);
  insertSystem(db, 30002661, 'Scout Gate', 20000389, 0.1);
  insertSystem(db, 30002662, 'Thera Entry', 20000389, 0.2);
  insertSystem(db, 30002663, 'Thera Exit', 20000389, 0.2);
  insertSystem(db, 30002664, 'Long Route 1', 20000389, 0.5);
  insertSystem(db, 30002665, 'Long Route 2', 20000389, 0.5);
  insertSystem(db, 30002666, 'Long Route 3', 20000389, 0.5);
  insertSystem(db, 30002667, 'Long Route 4', 20000389, 0.5);
  insertSystem(db, 31000005, 'Thera', 20000389, -1);
  insertSystem(db, 30000142, 'Jita', 20000389, 0.9);

  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    587,
    'Victim Ship',
    25,
    JSON.stringify({ type_id: 587, name: 'Victim Ship', group_id: 25 }),
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    603,
    'Attacker Ship',
    25,
    JSON.stringify({ type_id: 603, name: 'Attacker Ship', group_id: 25 }),
  );

  db.prepare(`INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at) VALUES (?, ?, ?, datetime('now'))`).run(
    'get_characters_character_id_location:2116626188:https://esi.evetech.net/latest/characters/2116626188/location/',
    JSON.stringify({ solar_system_id: 30002659 }),
    '2099-01-01 00:00:00',
  );
}

function insertSystem(
  db: Database.Database,
  systemId: number,
  name: string,
  constellationId: number,
  securityStatus: number,
): void {
  db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
    systemId,
    name,
    constellationId,
    JSON.stringify({
      system_id: systemId,
      name,
      constellation_id: constellationId,
      securityStatus,
      securityClass: securityStatus >= 0.5 ? 'A' : 'B',
    }),
  );
}
