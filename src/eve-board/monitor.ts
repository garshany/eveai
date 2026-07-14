/**
 * Feed-driven route monitoring.
 *
 * Official ESI owns character location, online state, death detection, and
 * system-jump traffic. EVE-KILL supplies one bounded one-hour baseline and the
 * single durable global feed supplies subsequent public kill activity.
 */

import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getEveCapabilities, hasFreshCapabilitySnapshot } from '../eve/capabilities.js';
import { subscribeEveKillFeed } from '../eve-kill/feed-poll.js';
import type { FeedEvent } from '../eve-kill/types.js';
import type { UserContext } from '../auth/user-resolver.js';
import {
  analyzeKillPattern,
  assessShip,
  scoreThreat,
  updateGankerCache,
} from './threat.js';
import {
  buildRouteThreatSnapshot,
  enrichRouteKillmail,
  type RouteThreatSnapshot,
} from './route-snapshot.js';
import {
  buildRouteThreatDigest,
  buildSystemDigest,
  detectJumpSpikes,
} from './analytics.js';
import {
  detectPursuit,
  formatIntelMessage,
  generateRouteIntelSummary,
} from './advisor.js';
import type {
  DangerEvent,
  JumpSpike,
  RouteMonitor,
  RouteStats,
  RouteThreatDigest,
  ShipAssessment,
  SystemThreatDigest,
  ThreatKillmail,
  ThreatLevel,
} from './types.js';
import {
  shouldSendDigestHeartbeat as shouldSendDigestHeartbeatWithInterval,
} from './monitor-helpers.js';

export { collectNewKillmailIds, extractKillPosition } from './monitor-helpers.js';

export type NotifySender = (chatId: number, text: string) => Promise<void>;
export type StopReason = 'arrived' | 'death' | 'offline' | 'manual' | 'auth' | 'baseline';

export type GankerIntel = {
  characterId: number;
  characterName: string;
  shipName: string;
  systems: Array<{
    systemId: number;
    systemName: string;
    lastSeen: string;
    killCount: number;
  }>;
  totalKills: number;
  lastSeenMinutesAgo: number;
  isMoving: boolean;
};

type MonitorInstance = {
  monitor: RouteMonitor;
  db: Db;
  sender: NotifySender;
  shipAssessment: ShipAssessment;
  unsubscribeFeed: () => void;
  baselinePromise: Promise<boolean>;
  baselineReady: boolean;
  locationTimer: ReturnType<typeof setInterval> | null;
  operationalTimer: ReturnType<typeof setInterval> | null;
  onlineTimer: ReturnType<typeof setInterval> | null;
  digestTimer: ReturnType<typeof setInterval> | null;
  pollingLocation: boolean;
  pollingOperations: boolean;
  pollingOnline: boolean;
  sendingDigest: boolean;
  offlineSince: number | null;
  locationFailures: number;
  alertCooldowns: Map<number, number>;
  previousJumps: Map<number, number>;
  killsBySystem: Map<number, ThreatKillmail[]>;
  recentKillsBySystem: Map<number, Array<{ systemId: number; time: string }>>;
  pendingInitialEvents: FeedEvent[];
  seenKillmailIds: Set<number>;
  feedEventTail: Promise<void>;
  lastDigestTime: number;
  lastDigestsAhead: SystemThreatDigest[];
  lastDigestsBehind: SystemThreatDigest[];
  lastOverallThreat: ThreatLevel;
  lastKillsSeen: number;
  lastPilotSystem: number;
  lastGankerSignature: string;
};

type GankerCacheRow = {
  character_id: number;
  character_name: string | null;
  system_id: number;
  kill_count: number;
  last_seen: string;
  ship_type_id: number | null;
};

type SystemJumpEntry = { system_id: number; ship_jumps: number };

const LOG = '[route-monitor]';
const LOCATION_INTERVAL_MS = 15_000;
const OPERATIONAL_INTERVAL_MS = 60_000;
const ONLINE_INTERVAL_MS = 60_000;
const DIGEST_INTERVAL_MS = 120_000;
const DIGEST_HEARTBEAT_MS = 6 * 60_000;
const OFFLINE_TIMEOUT_MINUTES = 30;
const MAX_LOCATION_FAILURES = 40;
const ALERT_COOLDOWN_MS = 5 * 60_000;
const KILL_WINDOW_MS = 60 * 60_000;
const PURSUIT_WINDOW_MS = 20 * 60_000;

export const activeMonitors = new Map<number, MonitorInstance>();

export type RouteMonitorStartOptions = {
  baseline?: RouteThreatSnapshot;
  initialEvents?: FeedEvent[];
  /** Restored monitors must not run without a trustworthy one-hour baseline. */
  stopOnBaselineFailure?: boolean;
};

export function startRouteMonitor(
  db: Db,
  chatId: number,
  characterId: number,
  route: number[],
  shipTypeId: number,
  shipName: string,
  sender: NotifySender,
  options: RouteMonitorStartOptions = {},
): Promise<boolean> {
  const routeSystems = normalizeRoute(route);
  if (routeSystems.length === 0) throw new Error('route monitor requires at least one valid system');
  if (activeMonitors.has(chatId)) stopRouteMonitor(chatId, 'manual');
  db.prepare('DELETE FROM route_monitor_kill_dedup WHERE chat_id = ?').run(chatId);

  const now = options.baseline?.scannedAt ?? new Date().toISOString();
  const monitor: RouteMonitor = {
    chatId,
    characterId,
    originId: routeSystems[0]!,
    destinationId: routeSystems[routeSystems.length - 1]!,
    routeSystems,
    currentSystemId: routeSystems[0]!,
    shipTypeId,
    shipName,
    shipEhp: 0,
    startedAt: now,
    lastLocationCheck: now,
    lastOnlineCheck: now,
    stats: {
      killsSeen: 0,
      jumpsCompleted: 0,
      startTime: now,
      systemTimes: {},
      dangerEvents: [],
    },
  };
  return activateMonitor(db, monitor, sender, options);
}

export function stopRouteMonitor(chatId: number, reason: StopReason): void {
  const instance = activeMonitors.get(chatId);
  if (!instance) return;
  detachInstance(instance);
  activeMonitors.delete(chatId);
  deleteMonitor(instance.db, chatId);

  const elapsed = Date.now() - Date.parse(instance.monitor.startedAt);
  const minutes = Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed / 60_000)) : 0;
  const message = formatStopMessage(
    reason,
    resolveSystemName(instance.db, instance.monitor.originId),
    resolveSystemName(instance.db, instance.monitor.destinationId),
    minutes,
    instance.monitor.stats,
  );
  void instance.sender(chatId, message).catch((error: unknown) => {
    console.error(`${LOG} stop notification failed chat=${chatId}: ${safeError(error)}`);
  });
  console.log(`${LOG} stopped chat=${chatId} reason=${reason} elapsed=${minutes}min`);
}

export function getActiveMonitor(chatId: number): RouteMonitor | null {
  return activeMonitors.get(chatId)?.monitor ?? null;
}

export function restoreMonitors(
  db: Db,
  sender: NotifySender,
  canDeliver: (chatId: number) => boolean = () => true,
): void {
  const rows = db.prepare('SELECT chat_id FROM route_monitors ORDER BY chat_id').all() as Array<{ chat_id: number }>;
  for (const row of rows) {
    // Preserve the durable row for a later run with that platform enabled, but
    // do not register a listener that could hold the process-wide feed cursor.
    if (!canDeliver(row.chat_id)) continue;
    try {
      const monitor = loadMonitor(db, row.chat_id);
      if (!monitor || monitor.routeSystems.length === 0) {
        deleteMonitor(db, row.chat_id);
        continue;
      }
      void activateMonitor(db, monitor, sender, { stopOnBaselineFailure: true });
      console.log(`${LOG} restoring chat=${row.chat_id} route=${monitor.routeSystems.length} systems`);
    } catch (error) {
      console.error(`${LOG} restore failed chat=${row.chat_id}: ${safeError(error)}`);
      deleteMonitor(db, row.chat_id);
    }
  }
}

/** Detach timers/listeners while preserving rows for the next process start. */
export function shutdownRouteMonitors(): void {
  for (const instance of activeMonitors.values()) detachInstance(instance);
  activeMonitors.clear();
}

export function shouldSendDigestHeartbeat(
  lastDigestTime: number,
  digest: RouteThreatDigest,
  gankerCount: number,
): boolean {
  return shouldSendDigestHeartbeatWithInterval(
    lastDigestTime,
    digest,
    gankerCount,
    DIGEST_HEARTBEAT_MS,
  );
}

function activateMonitor(
  db: Db,
  monitor: RouteMonitor,
  sender: NotifySender,
  options: RouteMonitorStartOptions = {},
): Promise<boolean> {
  if (activeMonitors.has(monitor.chatId)) {
    throw new Error(`route monitor already active for chat ${monitor.chatId}`);
  }
  const shipAssessment = assessShip(db, monitor.shipTypeId);
  monitor.shipEhp = shipAssessment.ehp;
  saveMonitor(db, monitor);
  const instance: MonitorInstance = {
    monitor,
    db,
    sender,
    shipAssessment,
    unsubscribeFeed: () => {},
    baselinePromise: Promise.resolve(true),
    baselineReady: false,
    locationTimer: null,
    operationalTimer: null,
    onlineTimer: null,
    digestTimer: null,
    pollingLocation: false,
    pollingOperations: false,
    pollingOnline: false,
    sendingDigest: false,
    offlineSince: null,
    locationFailures: 0,
    alertCooldowns: new Map(),
    previousJumps: new Map(),
    killsBySystem: new Map(),
    recentKillsBySystem: new Map(),
    pendingInitialEvents: [...(options.initialEvents ?? [])],
    seenKillmailIds: new Set(),
    feedEventTail: Promise.resolve(),
    lastDigestTime: Date.now(),
    lastDigestsAhead: [],
    lastDigestsBehind: [],
    lastOverallThreat: 'LOW',
    lastKillsSeen: monitor.stats.killsSeen,
    lastPilotSystem: monitor.currentSystemId,
    lastGankerSignature: '',
  };

  activeMonitors.set(monitor.chatId, instance);
  instance.unsubscribeFeed = subscribeEveKillFeed(async (event) => {
    await handleRouteFeedEvent(instance, event);
  });
  // Listener registration intentionally precedes the asynchronous baseline.
  instance.baselinePromise = initializeRouteMonitor(
    instance,
    options.baseline,
    options.stopOnBaselineFailure === true,
  );

  void getEveCapabilities(db, 'route-monitor', getMonitorUserContext(monitor.chatId)).catch(() => {});
  void pollLocation(instance);
  void pollOnline(instance);
  instance.locationTimer = setInterval(() => void pollLocation(instance), LOCATION_INTERVAL_MS);
  instance.operationalTimer = setInterval(
    () => void pollOperationalState(instance),
    OPERATIONAL_INTERVAL_MS,
  );
  instance.onlineTimer = setInterval(() => void pollOnline(instance), ONLINE_INTERVAL_MS);
  instance.digestTimer = setInterval(() => void sendRouteDigest(instance), DIGEST_INTERVAL_MS);

  console.log(
    `${LOG} started chat=${monitor.chatId} char=${monitor.characterId} route=${monitor.routeSystems.length} `
    + `ship=${shipAssessment.shipName} (${shipAssessment.ehp} EHP)`,
  );
  return instance.baselinePromise;
}

function detachInstance(instance: MonitorInstance): void {
  if (instance.locationTimer) clearInterval(instance.locationTimer);
  if (instance.operationalTimer) clearInterval(instance.operationalTimer);
  if (instance.onlineTimer) clearInterval(instance.onlineTimer);
  if (instance.digestTimer) clearInterval(instance.digestTimer);
  instance.unsubscribeFeed();
}

async function initializeRouteMonitor(
  instance: MonitorInstance,
  suppliedBaseline?: RouteThreatSnapshot,
  stopOnFailure = false,
): Promise<boolean> {
  let baselineAvailable = false;
  try {
    const snapshot = suppliedBaseline
      ?? await buildRouteThreatSnapshot(instance.db, instance.monitor.routeSystems);
    if (activeMonitors.get(instance.monitor.chatId) !== instance) return false;
    if (snapshot.error) {
      console.warn(`${LOG} baseline unavailable chat=${instance.monitor.chatId}: ${snapshot.error}`);
    } else {
      baselineAvailable = true;
      const routeSystems = new Set(instance.monitor.routeSystems);
      for (const system of snapshot.systems) {
        if (!routeSystems.has(system.systemId)) continue;
        instance.killsBySystem.set(system.systemId, [...system.recentKills]);
        for (const kill of system.recentKills) instance.seenKillmailIds.add(kill.killmail_id);
      }
      rebuildRouteDigests(instance, new Map());
      await drainInitialFeedEvents(instance);
      console.log(
        `${LOG} baseline ready chat=${instance.monitor.chatId} kills=${snapshot.totalKills} `
        + `truncated=${snapshot.truncated}`,
      );
    }
  } catch (error) {
    console.error(`${LOG} baseline failed chat=${instance.monitor.chatId}: ${safeError(error)}`);
  } finally {
    instance.baselineReady = true;
  }
  if (!baselineAvailable && stopOnFailure && activeMonitors.get(instance.monitor.chatId) === instance) {
    // A restored monitor without its baseline would understate existing route
    // activity indefinitely. Remove its durable row and tell the user to start
    // a fresh route once the public feed is available again.
    stopRouteMonitor(instance.monitor.chatId, 'baseline');
    return false;
  }
  if (activeMonitors.get(instance.monitor.chatId) === instance) {
    void pollOperationalState(instance);
  }
  return baselineAvailable && instance.pendingInitialEvents.length === 0;
}

async function drainInitialFeedEvents(instance: MonitorInstance): Promise<void> {
  while (instance.pendingInitialEvents.length > 0) {
    const event = instance.pendingInitialEvents[0]!;
    try {
      await enqueueRouteFeedEvent(instance, event);
      instance.pendingInitialEvents.shift();
    } catch (error) {
      console.error(
        `${LOG} initial feed handoff failed chat=${instance.monitor.chatId}: ${safeError(error)}`,
      );
      return;
    }
  }
}

async function handleRouteFeedEvent(instance: MonitorInstance, event: FeedEvent): Promise<void> {
  const systemId = event.killmail.solarSystemId;
  if (!systemId || !instance.monitor.routeSystems.includes(systemId)) return;
  await instance.baselinePromise;
  if (activeMonitors.get(instance.monitor.chatId) !== instance) return;
  await enqueueRouteFeedEvent(instance, event);
}

/** Serialize baseline handoff, operational retry, and live-listener delivery. */
async function enqueueRouteFeedEvent(instance: MonitorInstance, event: FeedEvent): Promise<void> {
  const current = instance.feedEventTail.then(() => processRouteFeedEvent(instance, event));
  // Keep the queue usable after a rejected event while returning that rejection
  // to the caller that owns the durable global cursor.
  instance.feedEventTail = current.catch(() => {});
  await current;
}

async function processRouteFeedEvent(instance: MonitorInstance, event: FeedEvent): Promise<void> {
  const { monitor, db, sender, shipAssessment } = instance;
  const killmailId = event.killmail.killmailId;
  const systemId = event.killmail.solarSystemId;
  if (!systemId || !monitor.routeSystems.includes(systemId)) return;
  if (isRouteFeedEventPersisted(db, monitor.chatId, monitor.startedAt, killmailId)) {
    instance.seenKillmailIds.add(killmailId);
    return;
  }
  if (instance.seenKillmailIds.has(killmailId)) {
    persistAbsorbedRouteFeedEvent(db, monitor, event);
    return;
  }
  if (event.killmail.isNpc === true) {
    persistAbsorbedRouteFeedEvent(db, monitor, event);
    instance.seenKillmailIds.add(killmailId);
    return;
  }
  const eventTime = event.killmail.killmailTime
    ? Date.parse(event.killmail.killmailTime)
    : Number.NaN;
  if (Number.isFinite(eventTime) && eventTime < Date.now() - KILL_WINDOW_MS) {
    // A resumed durable feed can contain backlog from a long outage. Acknowledge
    // it locally so the listener can release the global cursor, but never turn
    // historical activity into a current route threat or fresh ganker sighting.
    persistAbsorbedRouteFeedEvent(db, monitor, event);
    instance.seenKillmailIds.add(killmailId);
    return;
  }
  const enriched = await enrichRouteKillmail(db, event.killmail);
  const existing = pruneThreatKills(instance.killsBySystem.get(systemId) ?? []);
  const nextKills = [enriched, ...existing.filter((kill) => kill.killmail_id !== killmailId)];
  const systemName = resolveSystemName(db, systemId);
  const systemSec = resolveSystemSec(db, systemId);
  const pattern = analyzeKillPattern(nextKills, systemId, systemName, systemSec);
  const threat = scoreThreat(pattern, shipAssessment);
  const currentIndex = monitor.routeSystems.indexOf(monitor.currentSystemId);
  const systemIndex = monitor.routeSystems.indexOf(systemId);
  const distance = systemIndex - currentIndex;
  const now = Date.now();
  const shouldAlert = (threat.level === 'HIGH' || threat.level === 'CRITICAL')
    && now - (instance.alertCooldowns.get(systemId) ?? 0) >= ALERT_COOLDOWN_MS;

  // The feed cursor must not move until this awaited send succeeds. State and
  // dedup markers are mutated only after the persistent transaction succeeds,
  // so a delivery or SQLite failure retries without losing the event.
  if (shouldAlert) {
    const icon = threat.level === 'CRITICAL' ? '\u{1F534}' : '\u{1F7E0}';
    const location = distance === 0
      ? 'Вы здесь!'
      : distance > 0
        ? `${distance} прыжков впереди`
        : `${Math.abs(distance)} прыжков позади`;
    await sender(monitor.chatId, [
      '⚠️ <b>EVE-Board: активность на маршруте</b>',
      '',
      `${icon} ${systemName} (${systemSec.toFixed(1)}) — ${location}`,
      `  ${nextKills.length} PvP за последний час | ${threat.reason}`,
    ].join('\n'));
  }

  if (activeMonitors.get(monitor.chatId) !== instance) return;
  const dangerEvent: DangerEvent | null = shouldAlert
    ? {
        systemId,
        systemName,
        time: new Date().toISOString(),
        threatLevel: threat.level,
        description: threat.reason,
      }
    : null;
  const nextStats: RouteStats = {
    ...monitor.stats,
    killsSeen: monitor.stats.killsSeen + 1,
    dangerEvents: dangerEvent
      ? [...monitor.stats.dangerEvents, dangerEvent]
      : [...monitor.stats.dangerEvents],
  };

  // These writes are one atomic unit. In particular, a failed stats update
  // rolls back the ganker increment so replay cannot double-count it.
  const persisted = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO route_monitor_kill_dedup
        (chat_id, monitor_started_at, killmail_id, sequence_id)
      VALUES (?, ?, ?, ?)
    `).run(monitor.chatId, monitor.startedAt, killmailId, event.sequenceId);
    if (inserted.changes === 0) return false;
    updateGankerCache(db, [enriched], systemId);
    updateMonitorStats(db, monitor.chatId, nextStats);
    return true;
  })();
  if (!persisted) {
    instance.seenKillmailIds.add(killmailId);
    return;
  }

  instance.killsBySystem.set(systemId, nextKills);
  monitor.stats = nextStats;
  if (shouldAlert) {
    instance.alertCooldowns.set(systemId, now);
  }
  if (distance < 0) {
    const pursuit = instance.recentKillsBySystem.get(systemId) ?? [];
    pursuit.push({ systemId, time: enriched.killmail_time ?? new Date().toISOString() });
    instance.recentKillsBySystem.set(systemId, pursuit);
  }
  instance.seenKillmailIds.add(killmailId);
  try {
    refreshSystemDigest(instance, systemId, null);
  } catch (error) {
    // The durable state is already complete. A derived in-memory digest is
    // rebuilt by the operational poll, so it must not hold the feed cursor.
    console.error(`${LOG} feed digest refresh failed chat=${monitor.chatId}: ${safeError(error)}`);
  }
}

async function pollOperationalState(instance: MonitorInstance): Promise<void> {
  if (instance.pollingOperations || activeMonitors.get(instance.monitor.chatId) !== instance) return;
  instance.pollingOperations = true;
  try {
    await drainInitialFeedEvents(instance);
    const currentIndex = instance.monitor.routeSystems.indexOf(instance.monitor.currentSystemId);
    if (currentIndex < 0) return;
    await checkOwnDeath(instance);
    if (activeMonitors.get(instance.monitor.chatId) !== instance) return;

    const previous = new Map(instance.previousJumps);
    await pollJumps(instance);
    const systemNames = new Map(
      instance.monitor.routeSystems.map((systemId) => [systemId, resolveSystemName(instance.db, systemId)]),
    );
    const spikes = new Map<number, JumpSpike>();
    for (const spike of detectJumpSpikes(instance.previousJumps, previous, systemNames)) {
      spikes.set(spike.systemId, spike);
    }
    rebuildRouteDigests(instance, spikes);
    prunePursuitHistory(instance);
  } catch (error) {
    console.error(`${LOG} operational poll failed chat=${instance.monitor.chatId}: ${safeError(error)}`);
  } finally {
    instance.pollingOperations = false;
  }
}

async function pollLocation(instance: MonitorInstance): Promise<void> {
  if (instance.pollingLocation || activeMonitors.get(instance.monitor.chatId) !== instance) return;
  instance.pollingLocation = true;
  const { monitor, db } = instance;
  try {
    await ensureMonitorCapabilities(instance, 'route-monitor-location');
    const result = await callEsiOperation<{ solar_system_id?: number }>(
      db,
      'get_characters_character_id_location',
      { character_id: monitor.characterId },
      getMonitorUserContext(monitor.chatId),
    );
    if (!result.ok || !result.data.solar_system_id) {
      instance.locationFailures += 1;
      if (instance.locationFailures >= MAX_LOCATION_FAILURES) stopRouteMonitor(monitor.chatId, 'auth');
      return;
    }
    instance.locationFailures = 0;
    const nextSystem = result.data.solar_system_id;
    if (nextSystem === monitor.currentSystemId) return;
    const previousIndex = monitor.routeSystems.indexOf(monitor.currentSystemId);
    const nextIndex = monitor.routeSystems.indexOf(nextSystem);
    if (previousIndex >= 0) {
      const previousSystem = monitor.routeSystems[previousIndex]!;
      monitor.stats.systemTimes[previousSystem] =
        (monitor.stats.systemTimes[previousSystem] ?? 0) + LOCATION_INTERVAL_MS;
    }
    if (nextIndex > previousIndex && previousIndex >= 0) {
      monitor.stats.jumpsCompleted += nextIndex - previousIndex;
    }
    monitor.currentSystemId = nextSystem;
    monitor.lastLocationCheck = new Date().toISOString();
    saveMonitor(db, monitor);
    rebuildRouteDigests(instance, new Map());
    if (nextSystem === monitor.destinationId) stopRouteMonitor(monitor.chatId, 'arrived');
  } catch (error) {
    console.error(`${LOG} location poll failed chat=${monitor.chatId}: ${safeError(error)}`);
  } finally {
    instance.pollingLocation = false;
  }
}

async function pollOnline(instance: MonitorInstance): Promise<void> {
  if (instance.pollingOnline || activeMonitors.get(instance.monitor.chatId) !== instance) return;
  instance.pollingOnline = true;
  const { monitor, db } = instance;
  try {
    await ensureMonitorCapabilities(instance, 'route-monitor-online');
    const result = await callEsiOperation<{ online?: boolean }>(
      db,
      'get_characters_character_id_online',
      { character_id: monitor.characterId },
      getMonitorUserContext(monitor.chatId),
    );
    if (!result.ok) return;
    monitor.lastOnlineCheck = new Date().toISOString();
    if (result.data.online) {
      instance.offlineSince = null;
    } else if (instance.offlineSince === null) {
      instance.offlineSince = Date.now();
    } else if (Date.now() - instance.offlineSince > OFFLINE_TIMEOUT_MINUTES * 60_000) {
      stopRouteMonitor(monitor.chatId, 'offline');
    }
  } catch (error) {
    console.error(`${LOG} online poll failed chat=${monitor.chatId}: ${safeError(error)}`);
  } finally {
    instance.pollingOnline = false;
  }
}

async function checkOwnDeath(instance: MonitorInstance): Promise<void> {
  const { monitor, db } = instance;
  await ensureMonitorCapabilities(instance, 'route-monitor-killmails');
  const recent = await callEsiOperation<Array<{ killmail_id: number; killmail_hash: string }>>(
    db,
    'get_characters_character_id_killmails_recent',
    { character_id: monitor.characterId },
    getMonitorUserContext(monitor.chatId),
  );
  if (!recent.ok || recent.data.length === 0) return;
  const latest = recent.data[0]!;
  const lastDeathId = (monitor.stats as RouteStats & { lastDeathId?: number }).lastDeathId;
  if (lastDeathId === latest.killmail_id) return;
  const detail = await callEsiOperation<{ victim?: { character_id?: number } }>(
    db,
    'get_killmails_killmail_id_killmail_hash',
    { killmail_id: latest.killmail_id, killmail_hash: latest.killmail_hash },
  );
  if (!detail.ok || detail.data.victim?.character_id !== monitor.characterId) return;
  (monitor.stats as RouteStats & { lastDeathId?: number }).lastDeathId = latest.killmail_id;
  updateMonitorStats(db, monitor.chatId, monitor.stats);
  stopRouteMonitor(monitor.chatId, 'death');
}

async function pollJumps(instance: MonitorInstance): Promise<void> {
  const result = await callEsiOperation<SystemJumpEntry[]>(
    instance.db,
    'get_universe_system_jumps',
    {},
  );
  if (!result.ok) return;
  const wanted = new Set(instance.monitor.routeSystems);
  for (const entry of result.data) {
    if (wanted.has(entry.system_id)) instance.previousJumps.set(entry.system_id, entry.ship_jumps);
  }
}

function rebuildRouteDigests(instance: MonitorInstance, spikes: Map<number, JumpSpike>): void {
  instance.lastDigestsAhead = [];
  instance.lastDigestsBehind = [];
  for (const systemId of instance.monitor.routeSystems) {
    const kills = pruneThreatKills(instance.killsBySystem.get(systemId) ?? []);
    instance.killsBySystem.set(systemId, kills);
    refreshSystemDigest(instance, systemId, spikes.get(systemId) ?? null);
  }
}

function refreshSystemDigest(
  instance: MonitorInstance,
  systemId: number,
  jumpSpike: JumpSpike | null,
): void {
  const { monitor, db, shipAssessment } = instance;
  const currentIndex = monitor.routeSystems.indexOf(monitor.currentSystemId);
  const systemIndex = monitor.routeSystems.indexOf(systemId);
  if (currentIndex < 0 || systemIndex < 0) return;
  const kills = pruneThreatKills(instance.killsBySystem.get(systemId) ?? []);
  const systemName = resolveSystemName(db, systemId);
  const systemSec = resolveSystemSec(db, systemId);
  const pattern = analyzeKillPattern(kills, systemId, systemName, systemSec);
  const threat = scoreThreat(pattern, shipAssessment);
  const row = db.prepare(
    "SELECT count(*) AS count FROM route_ganker_cache WHERE system_id = ? AND last_seen >= datetime('now', '-1 hour')",
  ).get(systemId) as { count: number } | undefined;
  const digest = buildSystemDigest(
    systemId,
    systemName,
    systemSec,
    systemIndex - currentIndex,
    threat.level,
    threat.reason,
    kills,
    jumpSpike,
    row?.count ?? 0,
    db,
  );
  instance.lastDigestsAhead = instance.lastDigestsAhead.filter((entry) => entry.systemId !== systemId);
  instance.lastDigestsBehind = instance.lastDigestsBehind.filter((entry) => entry.systemId !== systemId);
  if (systemIndex >= currentIndex) instance.lastDigestsAhead.push(digest);
  else instance.lastDigestsBehind.push(digest);
  instance.lastDigestsAhead.sort((left, right) => left.jumpsFromPilot - right.jumpsFromPilot);
  instance.lastDigestsBehind.sort((left, right) => right.jumpsFromPilot - left.jumpsFromPilot);
}

async function sendRouteDigest(instance: MonitorInstance): Promise<void> {
  if (instance.sendingDigest || activeMonitors.get(instance.monitor.chatId) !== instance) return;
  if (instance.lastDigestsAhead.length === 0 && instance.lastDigestsBehind.length === 0) return;
  instance.sendingDigest = true;
  const { monitor, db, shipAssessment } = instance;
  try {
    const currentIndex = monitor.routeSystems.indexOf(monitor.currentSystemId);
    if (currentIndex < 0) return;
    const recent = [...instance.recentKillsBySystem.values()].flat();
    const pursuit = detectPursuit(monitor.routeSystems, currentIndex, recent);
    const digest = buildRouteThreatDigest(
      resolveSystemName(db, monitor.currentSystemId),
      currentIndex,
      monitor.routeSystems.length,
      resolveSystemName(db, monitor.originId),
      resolveSystemName(db, monitor.destinationId),
      instance.lastDigestsAhead,
      instance.lastDigestsBehind,
    );
    const gankers = getActiveGankers(db, monitor.routeSystems);
    const signature = buildGankerSignature(gankers);
    const shouldSend = monitor.stats.killsSeen > instance.lastKillsSeen
      || digest.overallThreat !== instance.lastOverallThreat
      || monitor.currentSystemId !== instance.lastPilotSystem
      || (signature !== '' && signature !== instance.lastGankerSignature)
      || pursuit !== null
      || shouldSendDigestHeartbeat(instance.lastDigestTime, digest, gankers.length);
    if (!shouldSend) return;

    const summary = await generateRouteIntelSummary(
      digest,
      shipAssessment,
      pursuit,
      gankers,
      {
        routeSystems: monitor.routeSystems,
        originId: monitor.originId,
        destinationId: monitor.destinationId,
        currentSystemId: monitor.currentSystemId,
      },
    );
    await instance.sender(monitor.chatId, formatIntelMessage(summary, {
      digest,
      ship: shipAssessment,
      gankerIntel: gankers,
    }));
    instance.lastKillsSeen = monitor.stats.killsSeen;
    instance.lastOverallThreat = digest.overallThreat;
    instance.lastPilotSystem = monitor.currentSystemId;
    instance.lastGankerSignature = signature;
    instance.lastDigestTime = Date.now();
  } catch (error) {
    console.error(`${LOG} digest failed chat=${monitor.chatId}: ${safeError(error)}`);
  } finally {
    instance.sendingDigest = false;
  }
}

function getActiveGankers(db: Db, routeSystems: number[]): GankerIntel[] {
  if (routeSystems.length === 0) return [];
  const placeholders = routeSystems.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT character_id, character_name, system_id, kill_count, last_seen, ship_type_id
    FROM route_ganker_cache
    WHERE system_id IN (${placeholders})
      AND last_seen >= datetime('now', '-30 minutes')
    ORDER BY last_seen DESC
  `).all(...routeSystems) as GankerCacheRow[];
  const grouped = new Map<number, GankerCacheRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.character_id) ?? [];
    current.push(row);
    grouped.set(row.character_id, current);
  }
  const now = Date.now();
  return [...grouped.entries()].map(([characterId, entries]) => {
    const latest = entries.reduce((best, row) =>
      Date.parse(row.last_seen) > Date.parse(best.last_seen) ? row : best,
    );
    const systems = entries.map((row) => ({
      systemId: row.system_id,
      systemName: resolveSystemName(db, row.system_id),
      lastSeen: row.last_seen,
      killCount: row.kill_count,
    }));
    return {
      characterId,
      characterName: latest.character_name || `ID:${characterId}`,
      shipName: latest.ship_type_id ? resolveTypeName(db, latest.ship_type_id) ?? '?' : '?',
      systems,
      totalKills: systems.reduce((sum, system) => sum + system.killCount, 0),
      lastSeenMinutesAgo: Math.max(0, Math.round((now - Date.parse(latest.last_seen)) / 60_000)),
      isMoving: new Set(systems.map((system) => system.systemId)).size >= 2,
    };
  }).sort((left, right) => {
    if (left.isMoving !== right.isMoving) return left.isMoving ? -1 : 1;
    return right.totalKills - left.totalKills;
  });
}

function buildGankerSignature(gankers: GankerIntel[]): string {
  return gankers.slice(0, 10).map((ganker) =>
    `${ganker.characterId}|${ganker.systems
      .map((system) => `${system.systemId}:${system.killCount}`)
      .sort()
      .join(',')}`,
  ).join(';');
}

function pruneThreatKills(kills: ThreatKillmail[]): ThreatKillmail[] {
  const cutoff = Date.now() - KILL_WINDOW_MS;
  return kills.filter((kill) => {
    const time = kill.killmail_time ? Date.parse(kill.killmail_time) : NaN;
    return Number.isFinite(time) && time >= cutoff;
  });
}

function prunePursuitHistory(instance: MonitorInstance): void {
  const cutoff = Date.now() - PURSUIT_WINDOW_MS;
  for (const [systemId, kills] of instance.recentKillsBySystem) {
    const fresh = kills.filter((kill) => Date.parse(kill.time) >= cutoff);
    if (fresh.length === 0) instance.recentKillsBySystem.delete(systemId);
    else instance.recentKillsBySystem.set(systemId, fresh);
  }
}

function getMonitorUserContext(chatId: number): UserContext {
  return { userId: 0, chatId };
}

async function ensureMonitorCapabilities(instance: MonitorInstance, intent: string): Promise<void> {
  const ctx = getMonitorUserContext(instance.monitor.chatId);
  if (hasFreshCapabilitySnapshot(ctx, instance.monitor.characterId)) return;
  await getEveCapabilities(instance.db, intent, ctx);
}

const SEC_SQL =
  "coalesce(json_extract(data_json, '$.securityStatus'), json_extract(data_json, '$.security'))";

function resolveSystemName(db: Db, systemId: number): string {
  const row = db.prepare('SELECT name FROM sde_systems WHERE system_id = ?').get(systemId) as { name: string } | undefined;
  return row?.name ?? `ID:${systemId}`;
}

function resolveSystemSec(db: Db, systemId: number): number {
  const row = db.prepare(`SELECT ${SEC_SQL} AS sec FROM sde_systems WHERE system_id = ?`).get(systemId) as { sec: number | null } | undefined;
  return typeof row?.sec === 'number' && Number.isFinite(row.sec)
    ? Math.round(row.sec * 10) / 10
    : 0;
}

function resolveTypeName(db: Db, typeId: number): string | null {
  const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  return row?.name ?? null;
}

function normalizeRoute(route: number[]): number[] {
  return route.filter((id, index) =>
    Number.isSafeInteger(id) && id > 0 && (index === 0 || id !== route[index - 1]),
  );
}

function formatStopMessage(
  reason: StopReason,
  originName: string,
  destinationName: string,
  minutes: number,
  stats: RouteStats,
): string {
  switch (reason) {
    case 'arrived':
      return [
        `✅ Прибытие: ${destinationName}. Мониторинг ${originName} → ${destinationName} завершён.`,
        `Время: ${minutes} мин | Прыжков: ${stats.jumpsCompleted} | Киллов на маршруте: ${stats.killsSeen}`,
      ].join('\n');
    case 'death':
      return `💀 Пилот погиб. Мониторинг ${originName} → ${destinationName} остановлен.`;
    case 'offline':
      return `📤 Пилот оффлайн >${OFFLINE_TIMEOUT_MINUTES} мин. Мониторинг остановлен.`;
    case 'auth':
      return `⚠️ Мониторинг ${originName} → ${destinationName} остановлен: нет доступа к данным персонажа.`;
    case 'baseline':
      return `⚠️ Мониторинг ${originName} → ${destinationName} остановлен: не удалось восстановить актуальный EVE-KILL срез. Запустите маршрут повторно позже.`;
    case 'manual':
      return `⏹ Мониторинг ${originName} → ${destinationName} остановлен.`;
  }
}

function saveMonitor(db: Db, monitor: RouteMonitor): void {
  db.prepare(`
    INSERT INTO route_monitors
      (chat_id, character_id, origin_id, destination_id, route_systems,
       current_system_id, ship_type_id, ship_name, ship_ehp,
       started_at, last_location_check, last_online_check, stats_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      character_id = excluded.character_id,
      origin_id = excluded.origin_id,
      destination_id = excluded.destination_id,
      route_systems = excluded.route_systems,
      current_system_id = excluded.current_system_id,
      ship_type_id = excluded.ship_type_id,
      ship_name = excluded.ship_name,
      ship_ehp = excluded.ship_ehp,
      started_at = excluded.started_at,
      last_location_check = excluded.last_location_check,
      last_online_check = excluded.last_online_check,
      stats_json = excluded.stats_json
  `).run(
    monitor.chatId,
    monitor.characterId,
    monitor.originId,
    monitor.destinationId,
    JSON.stringify(monitor.routeSystems),
    monitor.currentSystemId,
    monitor.shipTypeId,
    monitor.shipName,
    monitor.shipEhp,
    monitor.startedAt,
    monitor.lastLocationCheck,
    monitor.lastOnlineCheck,
    JSON.stringify(monitor.stats),
  );
}

export function loadMonitor(db: Db, chatId: number): RouteMonitor | null {
  const row = db.prepare(`
    SELECT chat_id, character_id, origin_id, destination_id, route_systems,
           current_system_id, ship_type_id, ship_name, ship_ehp,
           started_at, last_location_check, last_online_check, stats_json
    FROM route_monitors WHERE chat_id = ?
  `).get(chatId) as {
    chat_id: number;
    character_id: number;
    origin_id: number;
    destination_id: number;
    route_systems: string;
    current_system_id: number;
    ship_type_id: number;
    ship_name: string;
    ship_ehp: number;
    started_at: string;
    last_location_check: string;
    last_online_check: string;
    stats_json: string;
  } | undefined;
  if (!row) return null;
  try {
    const routeSystems = normalizeRoute(JSON.parse(row.route_systems) as number[]);
    const stats = JSON.parse(row.stats_json) as RouteStats;
    return {
      chatId: row.chat_id,
      characterId: row.character_id,
      originId: row.origin_id,
      destinationId: row.destination_id,
      routeSystems,
      currentSystemId: row.current_system_id,
      shipTypeId: row.ship_type_id,
      shipName: row.ship_name,
      shipEhp: row.ship_ehp,
      startedAt: row.started_at,
      lastLocationCheck: row.last_location_check,
      lastOnlineCheck: row.last_online_check,
      stats,
    };
  } catch {
    return null;
  }
}

function deleteMonitor(db: Db, chatId: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM route_monitor_kill_dedup WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM route_monitors WHERE chat_id = ?').run(chatId);
  })();
}

function isRouteFeedEventPersisted(
  db: Db,
  chatId: number,
  monitorStartedAt: string,
  killmailId: number,
): boolean {
  return db.prepare(`
    SELECT 1 FROM route_monitor_kill_dedup
    WHERE chat_id = ? AND monitor_started_at = ? AND killmail_id = ?
  `).get(chatId, monitorStartedAt, killmailId) !== undefined;
}

function persistAbsorbedRouteFeedEvent(
  db: Db,
  monitor: RouteMonitor,
  event: FeedEvent,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO route_monitor_kill_dedup
      (chat_id, monitor_started_at, killmail_id, sequence_id)
    VALUES (?, ?, ?, ?)
  `).run(
    monitor.chatId,
    monitor.startedAt,
    event.killmail.killmailId,
    event.sequenceId,
  );
}

function updateMonitorStats(db: Db, chatId: number, stats: RouteStats): void {
  db.prepare('UPDATE route_monitors SET stats_json = ? WHERE chat_id = ?')
    .run(JSON.stringify(stats), chatId);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
