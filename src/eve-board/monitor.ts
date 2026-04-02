/**
 * Route monitor poller — tracks pilot location, scans kills on the full route
 * (ahead + behind pilot), polls system jump traffic, fills the ganker cache,
 * and triggers threat alerts while pilot is in flight.
 *
 * Lifecycle:
 *   startRouteMonitor() → intervals + R2Z2 watches → stopRouteMonitor()
 *
 * Poll cadences:
 *   - Location:     every 15 s (ESI character location)
 *   - Kill scan:    every 60 s (ESI pre-filter + zKB across the active route)
 *   - Jump scan:    every 60 s (ESI system_jumps, same cycle as kills)
 *   - Online check: every 60 s (ESI character online)
 *
 * Auto-stop conditions:
 *   - Arrived at destination
 *   - Death (victim in killmail)
 *   - Manual stop
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getEveCapabilities, hasFreshCapabilitySnapshot } from '../eve/capabilities.js';
import type { KilllistItem } from '../eve-kill/client.js';
import { getKillmailBatch } from '../eve-kill/client.js';
import type { EveKillKillmail } from '../eve-kill/types.js';
import { analyzeKillPattern, scoreThreat, assessShip } from './threat.js';
import type {
  RouteMonitor,
  RouteStats,
  DangerEvent,
  ShipAssessment,
  SystemSnapshot,
  ThreatLevel,
  JumpSpike,
  SystemThreatDigest,
  RouteThreatDigest,
} from './types.js';
import { subscribeTopics, unsubscribeTopics } from '../eve-kill/zkb-ws.js';
import {
  detectJumpSpikes,
  buildSystemDigest,
  buildRouteThreatDigest,
} from './analytics.js';
import {
  detectPursuit,
  generateRouteIntelSummary,
  formatIntelMessage,
} from './advisor.js';
import type { UserContext } from '../auth/user-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotifySender = (chatId: number, text: string) => void;

type MonitorInstance = {
  monitor: RouteMonitor;
  locationTimer: ReturnType<typeof setInterval>;
  killTimer: ReturnType<typeof setInterval>;
  onlineTimer: ReturnType<typeof setInterval>;
  digestTimer: ReturnType<typeof setInterval>;
  sender: NotifySender;
  db: Db;
  shipAssessment: ShipAssessment;
  offlineSince: number | null;
  /** Cooldown: system_id → last alert timestamp. Don't re-alert same system within 5 min. */
  alertCooldowns: Map<number, number>;
  /** system_id → last known ship_jumps (for spike detection) */
  previousJumps: Map<number, number>;
  /** Rolling window of per-system snapshots */
  snapshots: SystemSnapshot[];
  /** Auto-created kill_watch topics for route systems (cleaned up on stop) */
  routeWatchTopics: string[];
  /** Accumulated kill data for current digest cycle */
  recentKillsBySystem: Map<number, Array<{ systemId: number; time: string }>>;
  /** Last digest send time */
  lastDigestTime: number;
  /** System threat digests from last scan — ahead of pilot */
  lastDigestsAhead: SystemThreatDigest[];
  /** System threat digests from last scan — behind pilot */
  lastDigestsBehind: SystemThreatDigest[];
  /** Previous digest overall threat — for delta detection */
  lastOverallThreat: ThreatLevel;
  /** Previous kills seen count — for delta detection */
  lastKillsSeen: number;
  /** Previous pilot system — detect system change */
  lastPilotSystem: number;
  /** Previous ganker signature for delta detection */
  lastGankerSignature: string;
  /** Killmail IDs already seen during this monitor session. */
  seenKillmailIds: Set<number>;
};

type StopReason = 'arrived' | 'death' | 'offline' | 'manual';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG = '[route-monitor]';
const LOCATION_INTERVAL_MS = 15_000;
const KILL_INTERVAL_MS = 60_000; // 60s — gives time for throttled zKB calls across all systems
const ONLINE_INTERVAL_MS = 60_000;
const DIGEST_INTERVAL_MS = 120_000; // 2 minutes
const DIGEST_HEARTBEAT_MS = 6 * 60_000; // resend actionable digest every 6 minutes even without deltas
const OFFLINE_TIMEOUT_MINUTES = 30;
/** Don't re-alert the same system within this window */
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
/** Rolling snapshot window: keep last 20 snapshots per system */
const MAX_SNAPSHOTS = 200;
/** Route watch label prefix — used to distinguish auto-created watches */
const ROUTE_WATCH_PREFIX = '[route] ';

// ---------------------------------------------------------------------------
// zKB fetch (direct, not via EVE-KILL which doesn't filter by system)
// ---------------------------------------------------------------------------

type ZkbFeedItem = {
  killmail_id: number;
  zkb?: { hash?: string; totalValue?: number; npc?: boolean; solo?: boolean };
};

/** Throttle zKB: max 1 req/sec to stay well under 60/min limit */
let lastZkbCall = 0;

async function fetchZkbSystemKills(systemId: number): Promise<ZkbFeedItem[]> {
  // Rate limit: 1 req per 2s to stay safe under zKB 60/min limit
  const now = Date.now();
  const elapsed = now - lastZkbCall;
  if (elapsed < 2000) {
    await new Promise((r) => setTimeout(r, 2000 - elapsed));
  }
  lastZkbCall = Date.now();

  const url = `${config.zkill.baseUrl}kills/systemID/${systemId}/pastSeconds/3600/`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': config.zkill.userAgent },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!res.ok) {
      if (res.status === 429) console.warn(`${LOG} zKB rate limited for system ${systemId}`);
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((item: unknown): item is ZkbFeedItem =>
      !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).killmail_id === 'number',
    );
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// ESI enrichment — enrich top kills with full killmail data
// ---------------------------------------------------------------------------

/** Max kills to enrich per system (ESI rate limit friendly). */
const MAX_ENRICH_PER_SYSTEM = 3;

type EsiKillmailVictim = { ship_type_id?: number; character_id?: number };
type EsiKillmailAttacker = { character_id?: number; ship_type_id?: number; final_blow?: boolean };
type EsiKillmail = {
  killmail_time?: string;
  victim?: EsiKillmailVictim;
  attackers?: EsiKillmailAttacker[];
};

/** Attacker info extracted during enrichment for ganker cache */
type ExtractedAttacker = { killmailId: number; characterId: number; characterName: string; shipTypeId: number };

/** Enrichment result: kills for threat analysis + raw attacker data for ganker cache */
type EnrichResult = {
  kills: KilllistItem[];
  attackers: ExtractedAttacker[];
  positions: Map<number, KillPosition>;
};
type KillPosition = { x: number; y: number; z: number };

/**
 * Enrich zKB items with ESI killmail data and return KilllistItem[] for analyzeKillPattern.
 * Follows the pattern from eve-kill/poll.ts enrichKills().
 * Also collects attacker character/ship data for the ganker cache.
 */
async function enrichZkbKills(
  db: Db,
  items: ZkbFeedItem[],
): Promise<EnrichResult> {
  // Phase 1: fetch ESI killmails, collect raw data
  type PendingKill = {
    item: ZkbFeedItem;
    km: EsiKillmail;
    victim: EsiKillmailVictim;
    attackers: EsiKillmailAttacker[];
    fb: EsiKillmailAttacker | undefined;
    shipInfo: { typeName: string; groupName: string } | null;
    victimShipTypeId: number | undefined;
  };
  const pending: PendingKill[] = [];
  const fallbacks: KilllistItem[] = [];
  const characterIdsToResolve = new Set<number>();

  for (const item of items.slice(0, MAX_ENRICH_PER_SYSTEM)) {
    const hash = item.zkb?.hash;
    if (!hash) {
      fallbacks.push(zkbToKilllistFallback(item));
      continue;
    }

    try {
      const r = await callEsiOperation<EsiKillmail>(
        db,
        'get_killmails_killmail_id_killmail_hash',
        { killmail_id: item.killmail_id, killmail_hash: hash },
      );

      if (!r.ok || !r.data) {
        fallbacks.push(zkbToKilllistFallback(item));
        continue;
      }

      const km = r.data;
      const victim = km.victim ?? {};
      const attackers = km.attackers ?? [];
      const fb = attackers.find((a) => a.final_blow === true) ?? attackers[0];
      const victimShipTypeId = victim.ship_type_id;
      const shipInfo = victimShipTypeId ? resolveTypeGroup(db, victimShipTypeId) : null;

      pending.push({ item, km, victim, attackers, fb, shipInfo, victimShipTypeId });

      // Collect all character IDs for batch name resolution
      if (victim.character_id && victim.character_id > 0) {
        characterIdsToResolve.add(victim.character_id);
      }
      for (const atk of attackers) {
        if (atk.character_id && atk.character_id > 0) {
          characterIdsToResolve.add(atk.character_id);
        }
      }
    } catch {
      fallbacks.push(zkbToKilllistFallback(item));
    }
  }

  // Phase 2: batch-resolve character names via ESI post_universe_names
  const nameMap = await resolveCharacterNames(db, characterIdsToResolve);
  const positions = await fetchKillPositions(db, pending.map((entry) => entry.item.killmail_id));

  // Phase 3: build results with resolved names
  const results: KilllistItem[] = [...fallbacks];
  const attackerList: ExtractedAttacker[] = [];

  for (const p of pending) {
    const fbName = p.fb?.character_id ? nameMap.get(p.fb.character_id) : undefined;
    const victimName = p.victim.character_id ? nameMap.get(p.victim.character_id) : undefined;

    results.push({
      killmail_id: p.item.killmail_id,
      killmail_time: typeof p.km.killmail_time === 'string' ? p.km.killmail_time : undefined,
      total_value: p.item.zkb?.totalValue ?? 0,
      is_npc: p.item.zkb?.npc ?? false,
      is_solo: p.item.zkb?.solo ?? false,
      attacker_count: p.attackers.length,
      ship_type_id: p.victimShipTypeId,
      ship_name: p.shipInfo?.typeName ?? undefined,
      ship_group_name: p.shipInfo?.groupName ?? undefined,
      final_blow_character_id: p.fb?.character_id,
      final_blow_character_name: fbName,
      victim_character_id: p.victim.character_id,
      victim_character_name: victimName,
    });

    // Collect attacker data for ganker cache (with resolved names)
    for (const atk of p.attackers) {
      if (atk.character_id && atk.character_id > 0) {
        attackerList.push({
          killmailId: p.item.killmail_id,
          characterId: atk.character_id,
          characterName: nameMap.get(atk.character_id) ?? '',
          shipTypeId: atk.ship_type_id ?? 0,
        });
      }
    }
  }

  return { kills: results, attackers: attackerList, positions };
}

async function fetchKillPositions(db: Db, killmailIds: number[]): Promise<Map<number, KillPosition>> {
  const uniqueIds = [...new Set(killmailIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (uniqueIds.length === 0) return new Map();

  try {
    const result = await getKillmailBatch(db, uniqueIds);
    if (!result.ok) return new Map();

    const map = new Map<number, KillPosition>();
    for (const killmail of result.data) {
      const position = extractKillPosition(killmail);
      if (!position || typeof killmail.killmail_id !== 'number') continue;
      map.set(killmail.killmail_id, position);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function extractKillPosition(killmail: EveKillKillmail): KillPosition | null {
  const raw = killmail as Record<string, unknown>;
  const nested = asRec(raw.position);
  const x = numOrNull(raw.x) ?? numOrNull(nested.x);
  const y = numOrNull(raw.y) ?? numOrNull(nested.y);
  const z = numOrNull(raw.z) ?? numOrNull(nested.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

/** Batch-resolve character names via ESI post_universe_names (max 100 per call). */
async function resolveCharacterNames(db: Db, ids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.size === 0) return map;
  try {
    const r = await callEsiOperation<Array<{ id: number; name: string }>>(
      db, 'post_universe_names', { ids: JSON.stringify([...ids].slice(0, 100)) },
    );
    if (r.ok && Array.isArray(r.data)) {
      for (const e of r.data) {
        if (e.id && e.name) map.set(e.id, e.name);
      }
    }
  } catch { /* non-critical — names stay empty */ }
  return map;
}

/** Fallback: build KilllistItem from zKB metadata when ESI enrichment fails. */
function zkbToKilllistFallback(item: ZkbFeedItem): KilllistItem {
  return {
    killmail_id: item.killmail_id,
    total_value: item.zkb?.totalValue ?? 0,
    is_npc: item.zkb?.npc ?? false,
    is_solo: item.zkb?.solo ?? false,
    attacker_count: 1,
    ship_name: undefined,
    ship_group_name: undefined,
    final_blow_character_id: undefined,
  };
}

function asRec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Resolve type name and group name from SDE for a given type_id. */
function resolveTypeGroup(
  db: Db,
  typeId: number,
): { typeName: string; groupName: string } | null {
  const row = db.prepare(`
    SELECT t.name AS type_name, g.name AS group_name
    FROM sde_types t
    JOIN sde_groups g ON g.group_id = t.group_id
    WHERE t.type_id = ?
  `).get(typeId) as { type_name: string; group_name: string } | undefined;
  if (!row) return null;
  return { typeName: row.type_name, groupName: row.group_name };
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

export const activeMonitors = new Map<number, MonitorInstance>();

export function collectNewKillmailIds(
  seenKillmailIds: Set<number>,
  kills: Array<{ killmail_id: number }>,
): Set<number> {
  const fresh = new Set<number>();
  for (const kill of kills) {
    if (seenKillmailIds.has(kill.killmail_id)) continue;
    seenKillmailIds.add(kill.killmail_id);
    fresh.add(kill.killmail_id);
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start monitoring a route for a given chat/character.
 * Persists the monitor to the DB and kicks off all poll intervals immediately.
 */
export function startRouteMonitor(
  db: Db,
  chatId: number,
  characterId: number,
  route: number[],
  shipTypeId: number,
  shipName: string,
  sender: NotifySender,
): void {
  // Stop any existing monitor for this chat
  if (activeMonitors.has(chatId)) {
    stopRouteMonitor(chatId, 'manual');
  }

  const now = new Date().toISOString();
  const monitor: RouteMonitor = {
    chatId,
    characterId,
    originId: route[0],
    destinationId: route[route.length - 1],
    routeSystems: route,
    currentSystemId: route[0],
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

  // Full dogma-based ship assessment from threat module
  const shipAssessment = assessShip(db, shipTypeId);
  monitor.shipEhp = shipAssessment.ehp;

  saveMonitor(db, monitor);

  // Record capability snapshot so ESI calls don't get 428
  void getEveCapabilities(db, 'route-monitor', { userId: 0, chatId }).catch(() => {});

  // Auto-subscribe R2Z2 kill watches for all route systems
  const routeWatchTopics = subscribeRouteWatches(db, chatId, route);

  const instance: MonitorInstance = {
    monitor,
    sender,
    db,
    shipAssessment,
    offlineSince: null,
    alertCooldowns: new Map(),
    previousJumps: new Map(),
    snapshots: [],
    routeWatchTopics,
    recentKillsBySystem: new Map(),
    lastDigestTime: Date.now(),
    lastDigestsAhead: [],
    lastDigestsBehind: [],
    lastOverallThreat: 'LOW' as ThreatLevel,
    lastKillsSeen: 0,
    lastPilotSystem: 0,
    lastGankerSignature: '',
    seenKillmailIds: new Set(),
    // Timers are assigned below after immediate polls
    locationTimer: null!,
    killTimer: null!,
    onlineTimer: null!,
    digestTimer: null!,
  };

  activeMonitors.set(chatId, instance);

  console.log(
    `${LOG} started chat=${chatId} char=${characterId} route=${route.length} systems, `
    + `ship=${shipAssessment.shipName} (${shipAssessment.ehp} EHP, ${shipAssessment.shipClass}), `
    + `watches=${routeWatchTopics.length}`,
  );

  // Immediate first poll, then intervals
  void pollLocation(instance);
  void pollKills(instance);
  void pollOnline(instance);

  instance.locationTimer = setInterval(() => void pollLocation(instance), LOCATION_INTERVAL_MS);
  instance.killTimer = setInterval(() => void pollKills(instance), KILL_INTERVAL_MS);
  instance.onlineTimer = setInterval(() => void pollOnline(instance), ONLINE_INTERVAL_MS);
  instance.digestTimer = setInterval(() => void sendRouteDigest(instance), DIGEST_INTERVAL_MS);
}

/**
 * Stop monitoring for a chat. Clears intervals, removes DB row, notifies user.
 */
export function stopRouteMonitor(chatId: number, reason: StopReason): void {
  const instance = activeMonitors.get(chatId);
  if (!instance) return;

  clearInterval(instance.locationTimer);
  clearInterval(instance.killTimer);
  clearInterval(instance.onlineTimer);
  clearInterval(instance.digestTimer);

  // Clean up auto-created route watches
  unsubscribeRouteWatches(instance.db, chatId, instance.routeWatchTopics);

  deleteMonitor(instance.db, chatId);
  activeMonitors.delete(chatId);

  const { monitor, sender } = instance;
  const elapsed = Date.now() - new Date(monitor.startedAt).getTime();
  const minutes = Math.round(elapsed / 60_000);

  const originName = resolveSystemName(instance.db, monitor.originId);
  const destName = resolveSystemName(instance.db, monitor.destinationId);

  const message = formatStopMessage(reason, originName, destName, minutes, monitor.stats);
  try {
    sender(chatId, message);
  } catch (err) {
    console.error(`${LOG} failed to send stop notification chat=${chatId}:`, (err as Error).message);
  }

  console.log(`${LOG} stopped chat=${chatId} reason=${reason} elapsed=${minutes}min`);
}

/**
 * Get the active monitor state for a chat, if any.
 */
export function getActiveMonitor(chatId: number): RouteMonitor | null {
  return activeMonitors.get(chatId)?.monitor ?? null;
}

/**
 * Restore monitors from DB after process restart.
 */
export function restoreMonitors(db: Db, sender: NotifySender): void {
  const rows = db.prepare('SELECT * FROM route_monitors').all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return;

  for (const row of rows) {
    const chatId = row.chat_id as number;
    const characterId = row.character_id as number;
    const routeSystems = JSON.parse(String(row.route_systems ?? '[]')) as number[];
    const shipTypeId = (row.ship_type_id as number) ?? 0;
    const shipName = String(row.ship_name ?? 'Unknown');

    console.log(`${LOG} restoring monitor chat=${chatId} route=${routeSystems.length} systems`);
    // Prime capabilities snapshot before starting ESI polls
    void getEveCapabilities(db, 'route-monitor-restore', { userId: 0, chatId }).catch(() => {});
    startRouteMonitor(db, chatId, characterId, routeSystems, shipTypeId, shipName, sender);
  }
}

// ---------------------------------------------------------------------------
// Poll: Location (15s)
// ---------------------------------------------------------------------------

async function pollLocation(inst: MonitorInstance): Promise<void> {
  const { monitor, db } = inst;
  try {
    await ensureMonitorCapabilities(inst, 'route-monitor-location');
    const loc = await callEsiOperation<{ solar_system_id?: number }>(
      db,
      'get_characters_character_id_location',
      { character_id: monitor.characterId },
      getMonitorUserContext(monitor.chatId),
    );

    if (!loc.ok || !loc.data?.solar_system_id) {
      const errInfo = !loc.ok ? `status=${(loc as { status?: number }).status} error=${(loc as { error?: string }).error}` : 'no solar_system_id';
      console.log(`${LOG} location: ESI failed — ${errInfo}`);
      return;
    }

    const newSystemId = loc.data.solar_system_id;
    if (newSystemId === monitor.currentSystemId) return;

    // System changed
    const prevIdx = monitor.routeSystems.indexOf(monitor.currentSystemId);
    monitor.currentSystemId = newSystemId;
    monitor.lastLocationCheck = new Date().toISOString();

    // Track time in previous system
    if (prevIdx >= 0) {
      const prevSystemId = monitor.routeSystems[prevIdx];
      const prevTime = monitor.stats.systemTimes[prevSystemId] ?? 0;
      monitor.stats.systemTimes[prevSystemId] = prevTime + LOCATION_INTERVAL_MS;
    }

    // Jumps completed
    const newIdx = monitor.routeSystems.indexOf(newSystemId);
    if (newIdx > prevIdx && prevIdx >= 0) {
      monitor.stats.jumpsCompleted += newIdx - prevIdx;
    }

    updateMonitorSystem(db, monitor.chatId, newSystemId);

    // Check arrival
    if (newSystemId === monitor.destinationId) {
      console.log(`${LOG} chat=${monitor.chatId} arrived at destination`);
      stopRouteMonitor(monitor.chatId, 'arrived');
      return;
    }

    const sysName = resolveSystemName(db, newSystemId);
    const remaining = monitor.routeSystems.length - 1 - (newIdx >= 0 ? newIdx : 0);
    console.log(`${LOG} chat=${monitor.chatId} jumped to ${sysName} (${remaining} left)`);
  } catch (err) {
    console.error(`${LOG} location poll error chat=${monitor.chatId}:`, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Poll: Kill scan (60s)
// Strategy: ESI system_kills as fast filter → zKB only for active or tactically
// relevant systems across the full route
// + ESI character killmails for own death detection
// ---------------------------------------------------------------------------

type SystemKillEntry = { system_id: number; ship_kills: number; pod_kills: number; npc_kills: number };

async function pollKills(inst: MonitorInstance): Promise<void> {
  const { monitor, db, sender, shipAssessment, alertCooldowns } = inst;
  try {
    const currentIdx = monitor.routeSystems.indexOf(monitor.currentSystemId);
    if (currentIdx < 0) return;

    // Scan ALL systems on the route — no range limit
    const allScanSystems = [...monitor.routeSystems];
    if (allScanSystems.length === 0) return;

    // Hybrid: ESI pre-filter (free, 1 call) + always scan key systems via zKB
    const activeSystemIds = await getActiveSystemsFromEsi(db, allScanSystems);

    // Always scan via zKB: current system + known dangerous + systems with gankers
    const mustScanIds = new Set<number>([monitor.currentSystemId]);
    for (const sysId of allScanSystems) {
      if (activeSystemIds.has(sysId)) mustScanIds.add(sysId);
      const sec = resolveSystemSec(db, sysId);
      if (sec < 0.7) mustScanIds.add(sysId); // lowsec always
      const gc = db.prepare(
        "SELECT 1 FROM route_ganker_cache WHERE system_id = ? AND last_seen >= datetime('now', '-30 minutes') LIMIT 1",
      ).get(sysId);
      if (gc) mustScanIds.add(sysId);
    }

    const zkbScanSystems = [...mustScanIds];
    console.log(
      `${LOG} kill scan: ${allScanSystems.length} total, ${zkbScanSystems.length} via zKB (ESI=${activeSystemIds.size} active)`,
    );

    // Step 2: Death detection via ESI character killmails (own kills/losses)
    await checkOwnDeath(inst);

    // Snapshot jump counts BEFORE pollJumps updates them (for spike detection)
    const previousJumpsSnapshot = new Map(inst.previousJumps);

    // Step 3: System jumps polling (same cadence — updates inst.previousJumps in place)
    await pollJumps(inst, allScanSystems, currentIdx);

    // Step 4: zKB details only for systems with ship_kills > 0
    // Build system digests for analytics + intelligence layers
    const now = Date.now();
    let observedNewKills = 0;
    const threatsAhead: string[] = [];
    const threatsBehind: string[] = [];
    const systemDigestsAhead: SystemThreatDigest[] = [];
    const systemDigestsBehind: SystemThreatDigest[] = [];

    // Build system name map for jump spike detection
    const systemNames = new Map<number, string>();
    for (const sysId of allScanSystems) {
      systemNames.set(sysId, resolveSystemName(db, sysId));
    }

    // Detect jump spikes: current values (post-poll) vs previous snapshot (pre-poll)
    const jumpSpikes = detectJumpSpikes(inst.previousJumps, previousJumpsSnapshot, systemNames);
    const spikeMap = new Map<number, JumpSpike>();
    for (const spike of jumpSpikes) {
      spikeMap.set(spike.systemId, spike);
    }

    for (const sysId of allScanSystems) {
      const sysIdx = monitor.routeSystems.indexOf(sysId);
      const isAhead = sysIdx > currentIdx;
      const isCurrent = sysId === monitor.currentSystemId;
      const jumpDist = sysIdx - currentIdx; // positive = ahead, negative = behind, 0 = current

      const sysName = resolveSystemName(db, sysId);
      const sysSec = resolveSystemSec(db, sysId);

      // Query ganker cache for this system
      const gankerRow = db.prepare(
        "SELECT count(*) as cnt FROM route_ganker_cache WHERE system_id = ? AND last_seen >= datetime('now', '-1 hour')",
      ).get(sysId) as { cnt: number } | undefined;
      const gankerCount = gankerRow?.cnt ?? 0;

      // Only zKB scan selected systems; others get quiet digest
      if (!mustScanIds.has(sysId)) {
        const quietDigest = buildSystemDigest(
          sysId, sysName, sysSec, jumpDist,
          'LOW' as ThreatLevel, 'тихо', [], spikeMap.get(sysId) ?? null, gankerCount, db,
        );
        if (isAhead || isCurrent) systemDigestsAhead.push(quietDigest);
        else systemDigestsBehind.push(quietDigest);
        continue;
      }

      const feed = await fetchZkbSystemKills(sysId);
      if (feed.length === 0) {
        const quietDigest = buildSystemDigest(
          sysId, sysName, sysSec, jumpDist,
          'LOW' as ThreatLevel, 'тихо', [], spikeMap.get(sysId) ?? null, gankerCount, db,
        );
        if (isAhead || isCurrent) systemDigestsAhead.push(quietDigest);
        else systemDigestsBehind.push(quietDigest);
        continue;
      }

      const pvpKills = feed.filter((k) => !k.zkb?.npc);
      if (pvpKills.length === 0) {
        const quietDigest = buildSystemDigest(
          sysId, sysName, sysSec, jumpDist,
          'LOW' as ThreatLevel, 'только NPC', [], spikeMap.get(sysId) ?? null, gankerCount, db,
        );
        if (isAhead || isCurrent) systemDigestsAhead.push(quietDigest);
        else systemDigestsBehind.push(quietDigest);
        continue;
      }

      const newKillmailIds = collectNewKillmailIds(inst.seenKillmailIds, pvpKills);
      const enrichResult = await enrichZkbKills(db, pvpKills);
      const pattern = analyzeKillPattern(enrichResult.kills, sysId, sysName, sysSec);
      const threat = scoreThreat(pattern, shipAssessment);

      monitor.stats.killsSeen += newKillmailIds.size;
      observedNewKills += newKillmailIds.size;

      // Upsert ganker cache only for genuinely new killmails from this session.
      const newAttackers = enrichResult.attackers.filter((attacker) => newKillmailIds.has(attacker.killmailId));
      if (newAttackers.length > 0) {
        upsertGankerCache(db, sysId, newAttackers);
      }

      // Build system digest for Level 2+3 analytics
      const killsForDigest = enrichResult.kills.map((k) => ({
        killmail_time: k.killmail_time,
        killmail_id: k.killmail_id,
        ship_name: k.ship_name,
        victim_character_name: k.victim_character_name,
        final_blow_character_name: k.final_blow_character_name,
        total_value: k.total_value,
        attacker_count: k.attacker_count,
        is_solo: k.is_solo,
        position: enrichResult.positions.get(k.killmail_id),
      }));
      const sysDigest = buildSystemDigest(
        sysId, sysName, sysSec, jumpDist,
        threat.level, threat.reason,
        killsForDigest, spikeMap.get(sysId) ?? null, gankerCount, db,
      );
      if (isAhead || isCurrent) systemDigestsAhead.push(sysDigest);
      else systemDigestsBehind.push(sysDigest);

      // Track kills behind pilot for pursuit detection
      if (newKillmailIds.size > 0 && !isAhead && !isCurrent) {
        const existing = inst.recentKillsBySystem.get(sysId) ?? [];
        for (const k of enrichResult.kills) {
          if (!newKillmailIds.has(k.killmail_id)) continue;
          existing.push({
            systemId: sysId,
            time: k.killmail_time ?? new Date().toISOString(),
          });
        }
        inst.recentKillsBySystem.set(sysId, existing);
      }

      if (threat.level === 'HIGH' || threat.level === 'CRITICAL') {
        const lastAlert = alertCooldowns.get(sysId) ?? 0;
        if (now - lastAlert < ALERT_COOLDOWN_MS) continue;
        alertCooldowns.set(sysId, now);

        const icon = threat.level === 'CRITICAL' ? '\u{1F534}' : '\u{1F7E0}';

        if (isCurrent) {
          threatsAhead.push(
            `${icon} ${sysName} (${sysSec.toFixed(1)}) \u2014 \u0412\u044B \u0437\u0434\u0435\u0441\u044C!\n` +
            `  ${pvpKills.length} PvP \u043A\u0438\u043B\u043B\u043E\u0432 \u0437\u0430 1 \u0447\u0430\u0441 | ${threat.reason}`,
          );
        } else if (isAhead) {
          threatsAhead.push(
            `${icon} ${sysName} (${sysSec.toFixed(1)}) \u2014 ${Math.abs(jumpDist)} \u043F\u0440\u044B\u0436\u043A\u043E\u0432\n` +
            `  ${pvpKills.length} PvP \u043A\u0438\u043B\u043B\u043E\u0432 \u0437\u0430 1 \u0447\u0430\u0441 | ${threat.reason}`,
          );
        } else {
          threatsBehind.push(
            `\u{1F441} ${sysName} (${sysSec.toFixed(1)}) \u2014 ${Math.abs(jumpDist)} \u043F\u0440\u044B\u0436\u043A\u043E\u0432 \u043D\u0430\u0437\u0430\u0434\n` +
            `  ${pvpKills.length} PvP \u043A\u0438\u043B\u043B\u043E\u0432 \u0437\u0430 1 \u0447\u0430\u0441 | ${threat.reason}`,
          );
        }

        const event: DangerEvent = {
          systemId: sysId,
          systemName: sysName,
          time: new Date().toISOString(),
          threatLevel: threat.level,
          description: threat.reason,
        };
        monitor.stats.dangerEvents.push(event);
      }
    }

    // Store digests for the periodic digest sender
    inst.lastDigestsAhead = systemDigestsAhead;
    inst.lastDigestsBehind = systemDigestsBehind;

    // Send ONE batched alert with ahead/behind sections
    const totalThreats = threatsAhead.length + threatsBehind.length;
    console.log(`${LOG} kill scan done: ${monitor.stats.killsSeen} total kills seen, ${totalThreats} threats`);
    if (observedNewKills > 0 || totalThreats > 0) {
      updateMonitorStats(db, monitor.chatId, monitor.stats);
    }
    if (totalThreats > 0) {
      const parts: string[] = [];
      if (threatsAhead.length > 0) {
        parts.push(`\u26A0\uFE0F \u0423\u0433\u0440\u043E\u0437\u044B \u0432\u043F\u0435\u0440\u0435\u0434\u0438 (${monitor.shipName}, EHP ${Math.round(shipAssessment.ehp)}):\n` + threatsAhead.join('\n\n'));
      }
      if (threatsBehind.length > 0) {
        parts.push(`\u{1F441} \u0410\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u044C \u043F\u043E\u0437\u0430\u0434\u0438:\n` + threatsBehind.join('\n\n'));
      }
      try {
        sender(monitor.chatId, parts.join('\n\n'));
      } catch { /* */ }
    }

    // Trim stale pursuit data (older than 20 minutes)
    const pursuitCutoff = now - 20 * 60_000;
    for (const [sysId, kills] of inst.recentKillsBySystem) {
      const fresh = kills.filter((k) => new Date(k.time).getTime() >= pursuitCutoff);
      if (fresh.length === 0) inst.recentKillsBySystem.delete(sysId);
      else inst.recentKillsBySystem.set(sysId, fresh);
    }
  } catch (err) {
    console.error(`${LOG} kill scan error chat=${monitor.chatId}:`, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Periodic route digest — Level 2+3 analytics and intelligence (every 2 min)
// ---------------------------------------------------------------------------

async function sendRouteDigest(inst: MonitorInstance): Promise<void> {
  const { monitor, db, sender, shipAssessment } = inst;
  try {
    const currentIdx = monitor.routeSystems.indexOf(monitor.currentSystemId);
    if (currentIdx < 0) return;

    // Skip if no digest data yet (first poll cycle hasn't run)
    if (inst.lastDigestsAhead.length === 0 && inst.lastDigestsBehind.length === 0) return;

    // 1. Detect pursuit from accumulated kill data behind pilot
    const allRecentKills: Array<{ systemId: number; time: string }> = [];
    for (const [, kills] of inst.recentKillsBySystem) {
      allRecentKills.push(...kills);
    }
    const pursuit = detectPursuit(monitor.routeSystems, currentIdx, allRecentKills);

    // 2. Build route threat digest from last scan data
    const pilotSystem = resolveSystemName(db, monitor.currentSystemId);
    const originName = resolveSystemName(db, monitor.originId);
    const destName = resolveSystemName(db, monitor.destinationId);
    const digest = buildRouteThreatDigest(
      pilotSystem, currentIdx,
      monitor.routeSystems.length,
      originName, destName,
      inst.lastDigestsAhead,
      inst.lastDigestsBehind,
    );

    // 2.5. Get active ganker intel across the route
    const gankerIntel = getActiveGankers(db, monitor.routeSystems);

    // === Only send when something CHANGED since last digest ===
    const newKills = monitor.stats.killsSeen - inst.lastKillsSeen;
    const threatChanged = digest.overallThreat !== inst.lastOverallThreat;
    const systemChanged = monitor.currentSystemId !== inst.lastPilotSystem;
    const gankerSignature = buildGankerSignature(gankerIntel);
    const gankersChanged = gankerSignature !== '' && gankerSignature !== inst.lastGankerSignature;
    const hasPursuit = pursuit !== null;
    const heartbeatDue = shouldSendDigestHeartbeat(inst.lastDigestTime, digest, gankerIntel.length);

    const shouldSend = newKills > 0 || threatChanged || systemChanged || gankersChanged || hasPursuit || heartbeatDue;

    if (!shouldSend) {
      console.log(`${LOG} digest skipped (no change) chat=${monitor.chatId} kills=${monitor.stats.killsSeen} threat=${digest.overallThreat}`);
      return;
    }

    inst.lastKillsSeen = monitor.stats.killsSeen;
    inst.lastOverallThreat = digest.overallThreat;
    inst.lastPilotSystem = monitor.currentSystemId;
    inst.lastGankerSignature = gankerSignature;

    // 3. Call LLM for route analysis — only when there's real intel
    const intelSummary = await generateRouteIntelSummary(
      digest, shipAssessment, pursuit, gankerIntel,
      {
        routeSystems: monitor.routeSystems,
        originId: monitor.originId,
        destinationId: monitor.destinationId,
        currentSystemId: monitor.currentSystemId,
      },
    );
    const intelText = formatIntelMessage(intelSummary, {
      digest,
      ship: shipAssessment,
      gankerIntel,
    });
    sender(monitor.chatId, intelText);

    if (pursuit) {
      console.log(
        `${LOG} pursuit detected chat=${monitor.chatId} confidence=${pursuit.confidence} systems=${pursuit.systemIds.length}`,
      );
    }

    inst.lastDigestTime = Date.now();
    console.log(
      `${LOG} digest sent chat=${monitor.chatId} overall=${digest.overallThreat} ahead=${inst.lastDigestsAhead.length} behind=${inst.lastDigestsBehind.length} gankers=${gankerIntel.length}`,
    );
  } catch (err) {
    console.error(`${LOG} digest error chat=${monitor.chatId}:`, (err as Error).message);
  }
}

export function shouldSendDigestHeartbeat(
  lastDigestTime: number,
  digest: RouteThreatDigest,
  gankerCount: number,
): boolean {
  if (Date.now() - lastDigestTime < DIGEST_HEARTBEAT_MS) {
    return false;
  }

  if (digest.overallThreat !== 'LOW') {
    return true;
  }

  const systems = [...digest.systemsAhead, ...digest.systemsBehind];
  if (gankerCount > 0) return true;

  return systems.some((system) =>
    system.recentKills.length > 0
    || system.gateKills.length > 0
    || system.gankerCount > 0
    || system.jumpSpike !== null,
  );
}

// ---------------------------------------------------------------------------
// ESI system_kills filter — one call for all systems, skip quiet ones
// ---------------------------------------------------------------------------

async function getActiveSystemsFromEsi(db: Db, systemIds: number[]): Promise<Set<number>> {
  const active = new Set<number>();
  try {
    const result = await callEsiOperation<SystemKillEntry[]>(db, 'get_universe_system_kills', {});
    if (!result.ok || !Array.isArray(result.data)) return active;

    const wanted = new Set(systemIds);
    for (const entry of result.data) {
      if (wanted.has(entry.system_id) && (entry.ship_kills > 0 || entry.pod_kills > 0)) {
        active.add(entry.system_id);
      }
    }
  } catch { /* non-critical, fall through to scan all */ }
  return active;
}

// ---------------------------------------------------------------------------
// ESI death detection — check own character killmails
// ---------------------------------------------------------------------------

async function checkOwnDeath(inst: MonitorInstance): Promise<void> {
  const { monitor, db } = inst;
  try {
    await ensureMonitorCapabilities(inst, 'route-monitor-killmails');
    const result = await callEsiOperation<Array<{ killmail_id: number; killmail_hash: string }>>(
      db,
      'get_characters_character_id_killmails_recent',
      { character_id: monitor.characterId },
      getMonitorUserContext(monitor.chatId),
    );
    if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return;

    // Check if latest killmail is a loss (fetch detail to see if we're the victim)
    const latest = result.data[0];
    const detail = await callEsiOperation<{ victim?: { character_id?: number } }>(
      db,
      'get_killmails_killmail_id_killmail_hash',
      { killmail_id: latest.killmail_id, killmail_hash: latest.killmail_hash },
    );
    if (!detail.ok || !detail.data) return;

    if (detail.data.victim?.character_id === monitor.characterId) {
      // Check if this is a NEW death (not one we already know about)
      const lastKnownDeath = (monitor.stats as Record<string, unknown>).lastDeathId as number | undefined;
      if (lastKnownDeath === latest.killmail_id) return;

      (monitor.stats as Record<string, unknown>).lastDeathId = latest.killmail_id;
      console.log(`${LOG} chat=${monitor.chatId} DEATH detected via ESI km=${latest.killmail_id}`);
      stopRouteMonitor(monitor.chatId, 'death');
    }
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Poll: Online check (60s)
// ---------------------------------------------------------------------------

async function pollOnline(inst: MonitorInstance): Promise<void> {
  const { monitor, db } = inst;
  try {
    await ensureMonitorCapabilities(inst, 'route-monitor-online');
    const online = await callEsiOperation<{
      online?: boolean;
      last_login?: string;
      last_logout?: string;
    }>(
      db,
      'get_characters_character_id_online',
      { character_id: monitor.characterId },
      getMonitorUserContext(monitor.chatId),
    );

    if (!online.ok) return;

    monitor.lastOnlineCheck = new Date().toISOString();

    if (online.data.online) {
      // Pilot is online, reset offline tracker
      inst.offlineSince = null;
      return;
    }

    // Pilot is offline — track but don't auto-stop (user controls lifecycle)
    if (inst.offlineSince === null) {
      inst.offlineSince = Date.now();
    }
  } catch (err) {
    console.error(`${LOG} online poll error chat=${monitor.chatId}:`, (err as Error).message);
  }
}

function getMonitorUserContext(chatId: number): UserContext {
  return { userId: 0, chatId };
}

async function ensureMonitorCapabilities(inst: MonitorInstance, intent: string): Promise<void> {
  const ctx = getMonitorUserContext(inst.monitor.chatId);
  if (hasFreshCapabilitySnapshot(ctx, inst.monitor.characterId)) {
    return;
  }
  await getEveCapabilities(inst.db, intent, ctx);
}

// ---------------------------------------------------------------------------
// System jumps polling — detect traffic spikes
// ---------------------------------------------------------------------------

type SystemJumpEntry = { system_id: number; ship_jumps: number };

async function pollJumps(
  inst: MonitorInstance,
  scanSystems: number[],
  currentIdx: number,
): Promise<void> {
  const { db, monitor, previousJumps, snapshots } = inst;
  try {
    const result = await callEsiOperation<SystemJumpEntry[]>(
      db, 'get_universe_system_jumps', {},
    );
    if (!result.ok || !Array.isArray(result.data)) return;

    const wanted = new Set(scanSystems);
    const now = Date.now();

    for (const entry of result.data) {
      if (!wanted.has(entry.system_id)) continue;

      const prevCount = previousJumps.get(entry.system_id);
      previousJumps.set(entry.system_id, entry.ship_jumps);

      if (prevCount !== undefined) {
        const delta = entry.ship_jumps - prevCount;
        if (delta > 50) {
          const sysName = resolveSystemName(db, entry.system_id);
          console.log(
            `${LOG} jump spike: ${sysName} (${entry.system_id}) — ${prevCount} → ${entry.ship_jumps} (+${delta})`,
          );
        }
      }

      // Build snapshot
      const sysIdx = monitor.routeSystems.indexOf(entry.system_id);
      const jumpsFromPilot = sysIdx >= 0 ? sysIdx - currentIdx : 0;
      const sysName = resolveSystemName(db, entry.system_id);
      const sysSec = resolveSystemSec(db, entry.system_id);

      snapshots.push({
        systemId: entry.system_id,
        systemName: sysName,
        systemSec: sysSec,
        shipJumps: entry.ship_jumps,
        pvpKills: 0, // filled by kill scan separately
        jumpsFromPilot,
        timestamp: now,
      });
    }

    // Trim rolling window
    if (snapshots.length > MAX_SNAPSHOTS) {
      inst.snapshots = snapshots.slice(-MAX_SNAPSHOTS);
    }
  } catch (err) {
    console.error(`${LOG} jump poll error chat=${inst.monitor.chatId}:`, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Ganker intel — active gankers across route systems
// ---------------------------------------------------------------------------

/** Per-ganker intelligence for LLM context. */
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
  /** Ganker was seen in 2+ systems — possibly moving along the route. */
  isMoving: boolean;
};

type GankerCacheRow = {
  character_id: number;
  character_name: string | null;
  system_id: number;
  kill_count: number;
  last_seen: string;
  ship_type_id: number | null;
};

/**
 * Query active gankers (last 30 min) across the given route systems.
 * Groups by character, resolves ship and system names from SDE,
 * and flags gankers seen in 2+ systems as "moving".
 */
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

  if (rows.length === 0) return [];

  // Group by character_id
  const byChar = new Map<number, { name: string; shipTypeId: number; rows: GankerCacheRow[] }>();
  for (const row of rows) {
    let entry = byChar.get(row.character_id);
    if (!entry) {
      entry = { name: row.character_name ?? '', shipTypeId: row.ship_type_id ?? 0, rows: [] };
      byChar.set(row.character_id, entry);
    }
    entry.rows.push(row);
    // Keep the most recent ship_type_id
    if (row.ship_type_id && row.ship_type_id > 0) {
      entry.shipTypeId = row.ship_type_id;
    }
    // Keep the longest name
    if (row.character_name && row.character_name.length > entry.name.length) {
      entry.name = row.character_name;
    }
  }

  const now = Date.now();
  const result: GankerIntel[] = [];

  for (const [charId, entry] of byChar) {
    // Resolve ship name from SDE
    const shipInfo = entry.shipTypeId > 0 ? resolveTypeGroup(db, entry.shipTypeId) : null;

    const systems = entry.rows.map((r) => ({
      systemId: r.system_id,
      systemName: resolveSystemName(db, r.system_id),
      lastSeen: r.last_seen,
      killCount: r.kill_count,
    }));

    const totalKills = systems.reduce((acc, s) => acc + s.killCount, 0);
    const mostRecentMs = Math.max(...entry.rows.map((r) => new Date(r.last_seen).getTime()));
    const lastSeenMinutesAgo = Math.round((now - mostRecentMs) / 60_000);

    result.push({
      characterId: charId,
      characterName: entry.name || `ID:${charId}`,
      shipName: shipInfo?.typeName ?? '?',
      systems,
      totalKills,
      lastSeenMinutesAgo,
      isMoving: systems.length >= 2,
    });
  }

  // Sort: moving gankers first, then by total kills desc
  result.sort((a, b) => {
    if (a.isMoving !== b.isMoving) return a.isMoving ? -1 : 1;
    return b.totalKills - a.totalKills;
  });

  return result;
}

function buildGankerSignature(gankers: GankerIntel[]): string {
  return gankers
    .slice(0, 10)
    .map((ganker) => {
      const systems = ganker.systems
        .map((system) => `${system.systemId}:${system.killCount}`)
        .sort()
        .join(',');
      return `${ganker.characterId}|${ganker.isMoving ? 1 : 0}|${systems}`;
    })
    .join(';');
}

// ---------------------------------------------------------------------------
// Ganker cache — upsert attacker data from enriched kills
// ---------------------------------------------------------------------------

function upsertGankerCache(db: Db, systemId: number, attackers: ExtractedAttacker[]): void {
  if (attackers.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO route_ganker_cache (character_id, system_id, character_name, kill_count, last_seen, ship_type_id)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(character_id, system_id) DO UPDATE SET
      kill_count     = kill_count + excluded.kill_count,
      last_seen      = datetime('now'),
      character_name = CASE WHEN length(excluded.character_name) > 0 THEN excluded.character_name ELSE character_name END,
      ship_type_id   = CASE WHEN excluded.ship_type_id > 0 THEN excluded.ship_type_id ELSE ship_type_id END
  `);

  const grouped = new Map<number, {
    characterName: string;
    shipTypeId: number;
    killmailIds: Set<number>;
  }>();

  for (const atk of attackers) {
    const existing = grouped.get(atk.characterId) ?? {
      characterName: '',
      shipTypeId: 0,
      killmailIds: new Set<number>(),
    };
    existing.killmailIds.add(atk.killmailId);
    if (atk.characterName.length > existing.characterName.length) {
      existing.characterName = atk.characterName;
    }
    if (atk.shipTypeId > 0) {
      existing.shipTypeId = atk.shipTypeId;
    }
    grouped.set(atk.characterId, existing);
  }

  for (const [characterId, entry] of grouped) {
    stmt.run(
      characterId,
      systemId,
      entry.characterName,
      entry.killmailIds.size,
      entry.shipTypeId,
    );
  }
}

// ---------------------------------------------------------------------------
// R2Z2 route watches — auto-subscribe/unsubscribe for route systems
// ---------------------------------------------------------------------------

function subscribeRouteWatches(db: Db, chatId: number, routeSystems: number[]): string[] {
  const topics: string[] = [];

  for (const sysId of routeSystems) {
    const topic = `system.${sysId}`;
    const sysName = resolveSystemName(db, sysId);
    const label = `${ROUTE_WATCH_PREFIX}${sysName}`;

    // Use INSERT OR IGNORE to avoid duplicates (UNIQUE constraint on chat_id, topic)
    const existing = db.prepare(
      'SELECT id FROM kill_watches WHERE chat_id = ? AND topic = ?',
    ).get(chatId, topic) as { id: number } | undefined;

    if (!existing) {
      db.prepare(
        "INSERT INTO kill_watches (chat_id, topic, label, created_at) VALUES (?, ?, ?, datetime('now'))",
      ).run(chatId, topic, label);
    }

    topics.push(topic);
  }

  // Batch subscribe via R2Z2 WebSocket
  if (topics.length > 0) {
    subscribeTopics(topics);
    console.log(`${LOG} subscribed ${topics.length} route watches for chat=${chatId}`);
  }

  return topics;
}

function unsubscribeRouteWatches(db: Db, chatId: number, topics: string[]): void {
  if (topics.length === 0) return;

  // Only delete watches that have our route prefix label
  for (const topic of topics) {
    db.prepare(
      `DELETE FROM kill_watches WHERE chat_id = ? AND topic = ? AND label LIKE ?`,
    ).run(chatId, topic, `${ROUTE_WATCH_PREFIX}%`);
  }

  // Unsubscribe topics that no longer have any watchers
  for (const topic of topics) {
    const others = db.prepare(
      'SELECT id FROM kill_watches WHERE topic = ? LIMIT 1',
    ).get(topic) as { id: number } | undefined;
    if (!others) {
      unsubscribeTopics([topic]);
    }
  }

  console.log(`${LOG} unsubscribed ${topics.length} route watches for chat=${chatId}`);
}

// ---------------------------------------------------------------------------
// SDE helpers
// ---------------------------------------------------------------------------

const SEC_SQL =
  "coalesce(json_extract(data_json, '$.securityStatus'), json_extract(data_json, '$.security'))";

function resolveSystemName(db: Db, systemId: number): string {
  const row = db
    .prepare('SELECT name FROM sde_systems WHERE system_id = ?')
    .get(systemId) as { name: string } | undefined;
  return row?.name ?? `ID:${systemId}`;
}

function resolveSystemSec(db: Db, systemId: number): number {
  const row = db
    .prepare(`SELECT ${SEC_SQL} as sec FROM sde_systems WHERE system_id = ?`)
    .get(systemId) as { sec: number | null } | undefined;
  if (!row?.sec || typeof row.sec !== 'number') return 0;
  return Math.round(row.sec * 10) / 10;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------


function formatStopMessage(
  reason: StopReason,
  originName: string,
  destName: string,
  minutes: number,
  stats: RouteStats,
): string {
  switch (reason) {
    case 'arrived':
      return [
        `\u2705 Маршрут ${originName} \u2192 ${destName} завершён!`,
        `Время: ${minutes} мин | Прыжков: ${stats.jumpsCompleted} | Киллов на маршруте: ${stats.killsSeen}`,
        stats.dangerEvents.length > 0
          ? `Опасных событий: ${stats.dangerEvents.length}`
          : 'Опасных событий не было.',
      ].join('\n');

    case 'death':
      return [
        `\u{1F480} Пилот погиб! Мониторинг ${originName} \u2192 ${destName} остановлен.`,
        `Время в полёте: ${minutes} мин | Прыжков: ${stats.jumpsCompleted}`,
      ].join('\n');

    case 'offline':
      return [
        `\u{1F4E4} Пилот оффлайн >${OFFLINE_TIMEOUT_MINUTES} мин. Мониторинг ${originName} \u2192 ${destName} остановлен.`,
        `Прыжков: ${stats.jumpsCompleted} | Киллов: ${stats.killsSeen}`,
      ].join('\n');

    case 'manual':
      return `\u23F9 Мониторинг ${originName} \u2192 ${destName} остановлен.`;
  }
}

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

function saveMonitor(db: Db, monitor: RouteMonitor): void {
  db.prepare(
    `INSERT INTO route_monitors
       (chat_id, character_id, origin_id, destination_id, route_systems,
        current_system_id, ship_type_id, ship_name, ship_ehp,
        started_at, last_location_check, last_online_check, stats_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       character_id       = excluded.character_id,
       origin_id          = excluded.origin_id,
       destination_id     = excluded.destination_id,
       route_systems      = excluded.route_systems,
       current_system_id  = excluded.current_system_id,
       ship_type_id       = excluded.ship_type_id,
       ship_name          = excluded.ship_name,
       ship_ehp           = excluded.ship_ehp,
       started_at         = excluded.started_at,
       last_location_check = excluded.last_location_check,
       last_online_check  = excluded.last_online_check,
       stats_json         = excluded.stats_json`,
  ).run(
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
  const row = db
    .prepare(
      `SELECT chat_id, character_id, origin_id, destination_id, route_systems,
              current_system_id, ship_type_id, ship_name, ship_ehp,
              started_at, last_location_check, last_online_check, stats_json
       FROM route_monitors WHERE chat_id = ?`,
    )
    .get(chatId) as
    | {
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
      }
    | undefined;

  if (!row) return null;

  let routeSystems: number[] = [];
  try {
    routeSystems = JSON.parse(row.route_systems) as number[];
  } catch { /* default to empty */ }

  let stats: RouteStats = {
    killsSeen: 0,
    jumpsCompleted: 0,
    startTime: row.started_at,
    systemTimes: {},
    dangerEvents: [],
  };
  try {
    stats = JSON.parse(row.stats_json) as RouteStats;
  } catch { /* default */ }

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
}

function deleteMonitor(db: Db, chatId: number): void {
  db.prepare('DELETE FROM route_monitors WHERE chat_id = ?').run(chatId);
}

function updateMonitorSystem(db: Db, chatId: number, systemId: number): void {
  db.prepare(
    `UPDATE route_monitors
     SET current_system_id = ?, last_location_check = datetime('now')
     WHERE chat_id = ?`,
  ).run(systemId, chatId);
}

function updateMonitorStats(db: Db, chatId: number, stats: RouteStats): void {
  db.prepare(
    'UPDATE route_monitors SET stats_json = ? WHERE chat_id = ?',
  ).run(JSON.stringify(stats), chatId);
}
