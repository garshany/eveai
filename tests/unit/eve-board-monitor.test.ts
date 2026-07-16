import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrations.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import type { FeedEvent } from '../../src/eve-kill/types.js';
import type { RouteThreatDigest } from '../../src/eve-board/types.js';

const monitorMocks = vi.hoisted(() => {
  let feedListener: ((event: unknown) => void | Promise<void>) | null = null;
  let baselineResolve: ((value: unknown) => void) | null = null;
  const unsubscribe = vi.fn();

  return {
    unsubscribe,
    subscribe: vi.fn((listener: (event: unknown) => void | Promise<void>) => {
      feedListener = listener;
      return unsubscribe;
    }),
    buildSnapshot: vi.fn(() => new Promise((resolve) => { baselineResolve = resolve; })),
    enrichKillmail: vi.fn(),
    callEsi: vi.fn(async () => ({ ok: false as const, error: 'not available in test' })),
    getCapabilities: vi.fn(async () => ({ linked: true })),
    getFeedListener: () => feedListener,
    resolveBaseline: (value: unknown) => {
      if (!baselineResolve) throw new Error('baseline was not requested');
      baselineResolve(value);
    },
    reset: () => {
      feedListener = null;
      baselineResolve = null;
      unsubscribe.mockClear();
    },
  };
});

vi.mock('../../src/eve-kill/feed-poll.js', () => ({
  subscribeEveKillFeed: monitorMocks.subscribe,
}));

vi.mock('../../src/eve-board/route-snapshot.js', () => ({
  buildRouteThreatSnapshot: monitorMocks.buildSnapshot,
  enrichRouteKillmail: monitorMocks.enrichKillmail,
}));

vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: monitorMocks.callEsi }));

vi.mock('../../src/eve/capabilities.js', () => ({
  getEveCapabilities: monitorMocks.getCapabilities,
  hasFreshCapabilitySnapshot: () => true,
}));

vi.mock('../../src/eve-board/threat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve-board/threat.js')>();
  return {
    ...actual,
    assessShip: (_db: unknown, shipTypeId: number) => ({
      shipTypeId,
      shipName: 'Test Hauler',
      ehp: 9_000,
      alignTime: 12,
      warpSpeed: 3,
      shipClass: 'hauler',
      isHighValueTarget: true,
      survivalChance: 'DEAD',
    }),
    analyzeKillPattern: (_kills: unknown, systemId: number, systemName: string, systemSec: number) => ({
      systemId,
      systemName,
      systemSec,
      killCount: 3,
      timeWindowMinutes: 5,
      uniqueAttackers: new Set([1, 2, 3]),
      attackerShipTypes: new Map(),
      victimShipGroups: ['hauler'],
      estimatedGankDps: 1_200,
      isNpcOnly: false,
      latestKillTime: new Date().toISOString(),
    }),
    scoreThreat: () => ({ level: 'CRITICAL', reason: 'active test camp' }),
  };
});

import {
  collectNewKillmailIds,
  extractKillPosition,
  getActiveMonitor,
  restoreMonitors,
  shutdownRouteMonitors,
  shouldSendDigestHeartbeat,
  startRouteMonitor,
} from '../../src/eve-board/monitor.js';

afterEach(() => {
  shutdownRouteMonitors();
  vi.useRealTimers();
  vi.clearAllMocks();
  monitorMocks.reset();
});

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

  it('extracts normalized victim positions for gate attribution', () => {
    expect(extractKillPosition({
      position: { x: 40, y: 50, z: 60 },
    })).toEqual({ x: 40, y: 50, z: 60 });

    expect(extractKillPosition({})).toBeNull();
  });

  it('registers the feed listener before baseline and retries alerts without double mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'));
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare(
      'INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)',
    ).run(30_000_142, 'Jita', JSON.stringify({ securityStatus: 0.9 }));
    const sender = vi.fn(async (_chatId: number, _text: string): Promise<void> => {});
    sender.mockRejectedValueOnce(new Error('temporary delivery failure'));

    startRouteMonitor(db, 77, 90_000_001, [30_000_142], 648, 'Badger', sender);

    const listener = monitorMocks.getFeedListener();
    expect(listener).not.toBeNull();
    expect(monitorMocks.buildSnapshot).toHaveBeenCalledTimes(1);
    const persisted = db.prepare(
      'SELECT ship_ehp FROM route_monitors WHERE chat_id = 77',
    ).get() as { ship_ehp: number };
    expect(persisted.ship_ehp).toBe(9_000);

    monitorMocks.enrichKillmail.mockResolvedValue({
      killmail_id: 9_001,
      killmail_time: '2026-07-13T11:59:59Z',
      attacker_count: 3,
      is_npc: false,
      ship_group_name: 'Industrial',
    });
    const event: FeedEvent = {
      sequenceId: 501,
      killmail: {
        killmailId: 9_001,
        killmailHash: 'public-hash',
        // A delayed feed delivery may predate baseline.scannedAt while still
        // being absent from that baseline. It must survive the handoff.
        killmailTime: '2026-07-13T11:59:59Z',
        solarSystemId: 30_000_142,
        attackerCount: 3,
        isNpc: false,
        victim: { shipTypeId: 648 },
        attackers: [],
        items: [],
        siblings: [],
        sourceShape: 'feed',
      },
    };
    const firstAttempt = Promise.resolve(listener!(event));
    await Promise.resolve();
    expect(sender).not.toHaveBeenCalled();

    monitorMocks.resolveBaseline({
      routeSystems: [30_000_142],
      systems: [],
      jumpMap: new Map(),
      totalKills: 0,
      totalValueM: 0,
      truncated: false,
      requestCount: 1,
      error: null,
      scannedAt: '2026-07-13T12:00:00Z',
    });
    await expect(firstAttempt).rejects.toThrow('temporary delivery failure');
    expect(getActiveMonitor(77)?.stats.killsSeen).toBe(0);

    await listener!(event);
    await listener!(event);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(getActiveMonitor(77)?.stats.killsSeen).toBe(1);
    expect(monitorMocks.enrichKillmail).toHaveBeenCalledTimes(2);

    shutdownRouteMonitors();
    expect(monitorMocks.unsubscribe).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('discards an expired web monitor before a feed event can alert or block the cursor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'));
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    const chatId = -2_000_000_100;
    const userId = 100;
    const characterId = 90_000_100;
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, 'Web Pilot', ?)")
      .run(userId, characterId);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, 'web', ?)")
      .run(chatId, characterId);
    db.prepare(`
      INSERT INTO web_sessions (session_hash, csrf_hash, user_id, chat_id, expires_at)
      VALUES ('h1:web-monitor', 'h1:web-monitor-csrf', ?, ?, datetime('now', '+1 hour'))
    `).run(userId, chatId);
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (?, 'Web Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), '[]', ?)
    `).run(characterId, userId);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(chatId, characterId, userId);
    db.prepare('INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)')
      .run(30_000_142, 'Jita', JSON.stringify({ securityStatus: 0.9 }));
    const sender = vi.fn(async () => {});
    const baseline = {
      routeSystems: [30_000_142],
      systems: [],
      jumpMap: new Map<number, number>(),
      totalKills: 0,
      totalValueM: 0,
      truncated: false,
      requestCount: 1,
      error: null,
      scannedAt: '2026-07-13T12:00:00Z',
    };
    await expect(startRouteMonitor(
      db, chatId, characterId, [30_000_142], 648, 'Badger', sender, { baseline },
    )).resolves.toBe(true);
    const listener = monitorMocks.getFeedListener();
    expect(listener).not.toBeNull();
    db.prepare("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE chat_id = ?")
      .run(chatId);

    await listener!({
      sequenceId: 550,
      killmail: {
        killmailId: 9_050,
        killmailHash: 'expired-web-lane',
        killmailTime: '2026-07-13T11:59:59Z',
        solarSystemId: 30_000_142,
        attackerCount: 3,
        isNpc: false,
        victim: { shipTypeId: 648 },
        attackers: [],
        items: [],
        siblings: [],
        sourceShape: 'feed',
      },
    });

    expect(getActiveMonitor(chatId)).toBeNull();
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = ?').get(chatId)).toBeUndefined();
    expect(sender).not.toHaveBeenCalled();
    expect(monitorMocks.enrichKillmail).not.toHaveBeenCalled();
    db.close();
  });

  it('starts from a supplied shared baseline and drains captured handoff events without rescanning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:02Z'));
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare(
      'INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)',
    ).run(30_000_142, 'Jita', JSON.stringify({ securityStatus: 0.9 }));
    monitorMocks.enrichKillmail.mockResolvedValue({
      killmail_id: 9_002,
      killmail_time: '2026-07-13T12:00:01Z',
      attacker_count: 3,
      is_npc: false,
      ship_group_name: 'Industrial',
    });
    const event: FeedEvent = {
      sequenceId: 502,
      killmail: {
        killmailId: 9_002,
        killmailHash: 'public-hash-2',
        killmailTime: '2026-07-13T12:00:01Z',
        solarSystemId: 30_000_142,
        attackerCount: 3,
        isNpc: false,
        victim: { shipTypeId: 648 },
        attackers: [],
        items: [],
        siblings: [],
        sourceShape: 'feed',
      },
    };
    const offRouteEvent: FeedEvent = {
      ...event,
      sequenceId: 503,
      killmail: {
        ...event.killmail,
        killmailId: 9_003,
        solarSystemId: 30_000_143,
      },
    };
    const staleEvent: FeedEvent = {
      ...event,
      sequenceId: 504,
      killmail: {
        ...event.killmail,
        killmailId: 9_004,
        killmailTime: '2026-07-13T02:00:00Z',
      },
    };
    const sender = vi.fn(async () => {});

    const ready = startRouteMonitor(
      db,
      78,
      90_000_001,
      [30_000_142],
      648,
      'Badger',
      sender,
      {
        baseline: {
          routeSystems: [30_000_142],
          systems: [],
          jumpMap: new Map(),
          totalKills: 0,
          totalValueM: 0,
          truncated: false,
          requestCount: 1,
          error: null,
          scannedAt: '2026-07-13T12:00:00Z',
        },
        initialEvents: [offRouteEvent, staleEvent, event],
      },
    );

    await expect(ready).resolves.toBe(true);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(monitorMocks.buildSnapshot).not.toHaveBeenCalled();
    expect(monitorMocks.enrichKillmail).toHaveBeenCalledTimes(1);
    expect(getActiveMonitor(78)?.stats.killsSeen).toBe(1);
    shutdownRouteMonitors();
    db.close();
  });

  it('durably absorbs a feed replay already present in the baseline across restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:02Z'));
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare(
      'INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)',
    ).run(30_000_142, 'Jita', JSON.stringify({ securityStatus: 0.9 }));
    const event: FeedEvent = {
      sequenceId: 506,
      killmail: {
        killmailId: 9_006,
        killmailHash: 'public-hash-6',
        killmailTime: '2026-07-13T12:00:01Z',
        solarSystemId: 30_000_142,
        attackerCount: 3,
        isNpc: false,
        victim: { shipTypeId: 648 },
        attackers: [],
        items: [],
        siblings: [],
        sourceShape: 'feed',
      },
    };
    const baseline = {
      routeSystems: [30_000_142],
      systems: [{
        systemId: 30_000_142,
        routeIndex: 0,
        name: 'Jita',
        sec: 0.9,
        pvpKills: 1,
        npcKills: 0,
        totalValueM: 0,
        valueResolvedKills: 0,
        recentKills: [{
          killmail_id: 9_006,
          killmail_time: '2026-07-13T12:00:01Z',
          attacker_count: 3,
          is_npc: false,
          eve_kill_url: 'https://eve-kill.com/kill/9006',
          time_msk: null,
        }],
        gateKills: [],
      }],
      jumpMap: new Map<number, number>(),
      totalKills: 1,
      totalValueM: 0,
      truncated: false,
      requestCount: 1,
      error: null,
      scannedAt: '2026-07-13T12:00:00Z',
    };
    const sender = vi.fn(async () => {});
    await expect(startRouteMonitor(
      db, 80, 90_000_001, [30_000_142], 648, 'Badger', sender, { baseline },
    )).resolves.toBe(true);
    const listener = monitorMocks.getFeedListener();
    expect(listener).not.toBeNull();

    await listener!(event);
    expect(monitorMocks.enrichKillmail).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
    expect((db.prepare(
      'SELECT COUNT(*) AS n FROM route_monitor_kill_dedup WHERE chat_id = 80',
    ).get() as { n: number }).n).toBe(1);

    shutdownRouteMonitors();
    monitorMocks.buildSnapshot.mockResolvedValue({
      ...baseline,
      systems: [],
      totalKills: 0,
      error: 'baseline offline',
      scannedAt: '2026-07-13T12:00:02Z',
    });
    restoreMonitors(db, sender);
    await vi.waitFor(() => expect(getActiveMonitor(80)).toBeNull());
    expect(monitorMocks.enrichKillmail).not.toHaveBeenCalled();
    expect(sender).toHaveBeenCalledWith(
      80,
      expect.stringContaining('не удалось восстановить актуальный EVE-KILL срез'),
    );
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = 80').get()).toBeUndefined();

    shutdownRouteMonitors();
    db.close();
  });

  it('retries a failed route-state transaction without losing or double-counting the event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:02Z'));
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare(
      'INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)',
    ).run(30_000_142, 'Jita', JSON.stringify({ securityStatus: 0.9 }));
    monitorMocks.enrichKillmail.mockResolvedValue({
      killmail_id: 9_005,
      killmail_time: '2026-07-13T12:00:01Z',
      attacker_count: 3,
      is_npc: false,
      ship_group_name: 'Industrial',
      final_blow_character_id: 90_000_123,
      final_blow_character_name: 'Test Ganker',
    });
    const event: FeedEvent = {
      sequenceId: 505,
      killmail: {
        killmailId: 9_005,
        killmailHash: 'public-hash-5',
        killmailTime: '2026-07-13T12:00:01Z',
        solarSystemId: 30_000_142,
        attackerCount: 3,
        isNpc: false,
        victim: { shipTypeId: 648 },
        attackers: [],
        items: [],
        siblings: [],
        sourceShape: 'feed',
      },
    };
    const sender = vi.fn(async () => {});
    const ready = startRouteMonitor(
      db,
      79,
      90_000_001,
      [30_000_142],
      648,
      'Badger',
      sender,
      {
        baseline: {
          routeSystems: [30_000_142],
          systems: [],
          jumpMap: new Map(),
          totalKills: 0,
          totalValueM: 0,
          truncated: false,
          requestCount: 1,
          error: null,
          scannedAt: '2026-07-13T12:00:00Z',
        },
      },
    );
    await expect(ready).resolves.toBe(true);
    const listener = monitorMocks.getFeedListener();
    expect(listener).not.toBeNull();

    db.exec(`
      CREATE TRIGGER fail_route_monitor_stats
      BEFORE UPDATE OF stats_json ON route_monitors
      BEGIN
        SELECT RAISE(ABORT, 'forced stats failure');
      END
    `);
    await expect(listener!(event)).rejects.toThrow('forced stats failure');
    expect(getActiveMonitor(79)?.stats.killsSeen).toBe(0);
    expect((db.prepare(
      'SELECT COUNT(*) AS n FROM route_ganker_cache WHERE character_id = ?',
    ).get(90_000_123) as { n: number }).n).toBe(0);

    db.exec('DROP TRIGGER fail_route_monitor_stats');
    await Promise.all([listener!(event), listener!(event)]);
    expect(getActiveMonitor(79)?.stats.killsSeen).toBe(1);
    const ganker = db.prepare(
      'SELECT kill_count FROM route_ganker_cache WHERE character_id = ? AND system_id = ?',
    ).get(90_000_123, 30_000_142) as { kill_count: number };
    expect(ganker.kill_count).toBe(1);
    expect(sender).toHaveBeenCalledTimes(2);
    expect((db.prepare(
      'SELECT COUNT(*) AS n FROM route_monitor_kill_dedup WHERE chat_id = 79',
    ).get() as { n: number }).n).toBe(1);

    // A restored monitor must not remain active when its fresh one-hour
    // baseline is unavailable. Its durable state transitions to stopped.
    shutdownRouteMonitors();
    monitorMocks.enrichKillmail.mockClear();
    sender.mockClear();
    monitorMocks.buildSnapshot.mockResolvedValue({
      routeSystems: [30_000_142],
      systems: [],
      jumpMap: new Map(),
      totalKills: 0,
      totalValueM: 0,
      truncated: false,
      requestCount: 1,
      error: 'baseline offline',
      scannedAt: '2026-07-13T12:00:02Z',
    });
    restoreMonitors(db, sender);
    await vi.waitFor(() => expect(getActiveMonitor(79)).toBeNull());
    expect(monitorMocks.enrichKillmail).not.toHaveBeenCalled();
    expect(sender).toHaveBeenCalledWith(
      79,
      expect.stringContaining('не удалось восстановить актуальный EVE-KILL срез'),
    );
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = 79').get()).toBeUndefined();
    expect((db.prepare(
      'SELECT kill_count FROM route_ganker_cache WHERE character_id = ? AND system_id = ?',
    ).get(90_000_123, 30_000_142) as { kill_count: number }).kill_count).toBe(1);

    shutdownRouteMonitors();
    db.close();
  });

  it('preserves but does not restore a monitor whose chat platform is disabled', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare(`
      INSERT INTO route_monitors
        (chat_id, character_id, origin_id, destination_id, route_systems, current_system_id,
         ship_type_id, ship_name, ship_ehp, stats_json)
      VALUES (-80, 90000001, 30000142, 30000144, '[30000142,30000144]', 30000142,
              648, 'Badger', 9000, ?)
    `).run(JSON.stringify({
      killsSeen: 0,
      jumpsCompleted: 0,
      startTime: '2026-07-13T12:00:00Z',
      systemTimes: {},
      dangerEvents: [],
    }));

    restoreMonitors(db, vi.fn(async () => {}), () => false);

    expect(getActiveMonitor(-80)).toBeNull();
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = -80').get()).toBeDefined();
    db.close();
  });

  it('does not delete a monitor that became active before feed readiness restore', async () => {
    vi.useFakeTimers();
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare('INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)')
      .run(30_000_142, 'Jita', JSON.stringify({ securityStatus: 0.9 }));
    const sender = vi.fn(async () => {});
    const baseline = {
      routeSystems: [30_000_142],
      systems: [],
      jumpMap: new Map<number, number>(),
      totalKills: 0,
      totalValueM: 0,
      truncated: false,
      requestCount: 1,
      error: null,
      scannedAt: '2026-07-13T12:00:00Z',
    };

    await expect(startRouteMonitor(
      db, 0, 90_000_001, [30_000_142], 648, 'Badger', sender, { baseline },
    )).resolves.toBe(true);
    restoreMonitors(db, sender, () => true);

    expect(getActiveMonitor(0)).not.toBeNull();
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = 0').get()).toBeDefined();
    expect(monitorMocks.subscribe).toHaveBeenCalledTimes(1);
    expect(monitorMocks.buildSnapshot).not.toHaveBeenCalled();
    shutdownRouteMonitors();
    db.close();
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
