/**
 * Route monitor poller — tracks pilot location, scans kills ahead on route,
 * and triggers threat alerts while pilot is in flight.
 *
 * Lifecycle:
 *   startRouteMonitor() → intervals → stopRouteMonitor()
 *
 * Poll cadences:
 *   - Location:     every 15 s (ESI character location)
 *   - Kill scan:    every 30 s (EVE-KILL killlist for next 5 systems)
 *   - Online check: every 60 s (ESI character online)
 *
 * Auto-stop conditions:
 *   - Arrived at destination
 *   - Death (victim in killmail)
 *   - Offline > 30 min
 *   - Manual stop
 */

import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getKilllist } from '../eve-kill/client.js';
import { analyzeKillPattern, scoreThreat, updateGankerCache, assessShip } from './threat.js';
import type {
  RouteMonitor,
  RouteStats,
  DangerEvent,
  ShipAssessment,
  ThreatLevel,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotifySender = (chatId: number, text: string) => void;

type MonitorInstance = {
  monitor: RouteMonitor;
  locationTimer: ReturnType<typeof setInterval>;
  killTimer: ReturnType<typeof setInterval>;
  onlineTimer: ReturnType<typeof setInterval>;
  sender: NotifySender;
  db: Db;
  /** Ship assessment for threat scoring. */
  shipAssessment: ShipAssessment;
  /** Tracks when we last saw the pilot offline (epoch ms). */
  offlineSince: number | null;
};

type StopReason = 'arrived' | 'death' | 'offline' | 'manual';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG = '[route-monitor]';
const LOCATION_INTERVAL_MS = 15_000;
const KILL_INTERVAL_MS = 30_000;
const ONLINE_INTERVAL_MS = 60_000;
const SYSTEMS_AHEAD_COUNT = 5;
/** EVE-KILL killlist TTL for monitor scans — short, we want fresh data. */
const KILLLIST_TTL_SECONDS = 30;
const OFFLINE_TIMEOUT_MINUTES = 30;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

export const activeMonitors = new Map<number, MonitorInstance>();

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

  const instance: MonitorInstance = {
    monitor,
    sender,
    db,
    shipAssessment,
    offlineSince: null,
    // Timers are assigned below after immediate polls
    locationTimer: null!,
    killTimer: null!,
    onlineTimer: null!,
  };

  activeMonitors.set(chatId, instance);

  console.log(
    `${LOG} started chat=${chatId} char=${characterId} route=${route.length} systems, `
    + `ship=${shipAssessment.shipName} (${shipAssessment.ehp} EHP, ${shipAssessment.shipClass})`,
  );

  // Immediate first poll, then intervals
  void pollLocation(instance);
  void pollKills(instance);
  void pollOnline(instance);

  instance.locationTimer = setInterval(() => void pollLocation(instance), LOCATION_INTERVAL_MS);
  instance.killTimer = setInterval(() => void pollKills(instance), KILL_INTERVAL_MS);
  instance.onlineTimer = setInterval(() => void pollOnline(instance), ONLINE_INTERVAL_MS);
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

// ---------------------------------------------------------------------------
// Poll: Location (15s)
// ---------------------------------------------------------------------------

async function pollLocation(inst: MonitorInstance): Promise<void> {
  const { monitor, db } = inst;
  try {
    const loc = await callEsiOperation<{ solar_system_id?: number }>(
      db,
      'get_characters_character_id_location',
      { character_id: monitor.characterId },
      monitor.chatId,
    );

    if (!loc.ok || !loc.data?.solar_system_id) return;

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
// Poll: Kill scan (30s) — uses EVE-KILL killlist, same as route-planner
// ---------------------------------------------------------------------------

async function pollKills(inst: MonitorInstance): Promise<void> {
  const { monitor, db, sender, shipAssessment } = inst;
  try {
    const currentIdx = monitor.routeSystems.indexOf(monitor.currentSystemId);
    if (currentIdx < 0) return;

    const systemsAhead = monitor.routeSystems.slice(
      currentIdx + 1,
      currentIdx + 1 + SYSTEMS_AHEAD_COUNT,
    );
    if (systemsAhead.length === 0) return;

    for (const sysId of systemsAhead) {
      const result = await getKilllist(db, { system_id: sysId, limit: 20 }, KILLLIST_TTL_SECONDS);
      if (!result.ok || result.data.length === 0) continue;

      const kills = result.data;

      // Death detection: check if user's character is a victim
      for (const kill of kills) {
        if (kill.victim_character_id === monitor.characterId) {
          console.log(`${LOG} chat=${monitor.chatId} DEATH detected km=${kill.killmail_id}`);
          stopRouteMonitor(monitor.chatId, 'death');
          return;
        }
      }

      const sysName = resolveSystemName(db, sysId);
      const sysSec = resolveSystemSec(db, sysId);
      const pattern = analyzeKillPattern(kills, sysId, sysName, sysSec);
      const threat = scoreThreat(pattern, shipAssessment);

      // Update ganker cache with observed attackers
      updateGankerCache(db, kills, sysId);

      monitor.stats.killsSeen += kills.length;

      if (threat.level === 'HIGH' || threat.level === 'CRITICAL') {
        const jumpsAhead = monitor.routeSystems.indexOf(sysId) - currentIdx;
        const alert = formatThreatAlert(
          sysName, sysSec, jumpsAhead, kills.length,
          threat.level, threat.reason, monitor.shipName,
        );

        const event: DangerEvent = {
          systemId: sysId,
          systemName: sysName,
          time: new Date().toISOString(),
          threatLevel: threat.level,
          description: threat.reason,
        };
        monitor.stats.dangerEvents.push(event);

        updateMonitorStats(db, monitor.chatId, monitor.stats);

        try {
          sender(monitor.chatId, alert);
        } catch { /* notification failure is non-fatal */ }
      }
    }
  } catch (err) {
    console.error(`${LOG} kill scan error chat=${monitor.chatId}:`, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Poll: Online check (60s)
// ---------------------------------------------------------------------------

async function pollOnline(inst: MonitorInstance): Promise<void> {
  const { monitor, db } = inst;
  try {
    const online = await callEsiOperation<{
      online?: boolean;
      last_login?: string;
      last_logout?: string;
    }>(
      db,
      'get_characters_character_id_online',
      { character_id: monitor.characterId },
      monitor.chatId,
    );

    if (!online.ok) return;

    monitor.lastOnlineCheck = new Date().toISOString();

    if (online.data.online) {
      // Pilot is online, reset offline tracker
      inst.offlineSince = null;
      return;
    }

    // Pilot is offline
    if (inst.offlineSince === null) {
      // Start tracking offline time from last_logout if available
      if (online.data.last_logout) {
        inst.offlineSince = new Date(online.data.last_logout).getTime();
      } else {
        inst.offlineSince = Date.now();
      }
    }

    const offlineMinutes = (Date.now() - inst.offlineSince) / 60_000;
    if (offlineMinutes > OFFLINE_TIMEOUT_MINUTES) {
      console.log(
        `${LOG} chat=${monitor.chatId} offline for ${Math.round(offlineMinutes)} min, stopping`,
      );
      stopRouteMonitor(monitor.chatId, 'offline');
    }
  } catch (err) {
    console.error(`${LOG} online poll error chat=${monitor.chatId}:`, (err as Error).message);
  }
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

function formatThreatAlert(
  systemName: string,
  systemSec: number,
  jumpsAhead: number,
  killCount: number,
  threatLevel: ThreatLevel,
  reason: string,
  shipName: string,
): string {
  const emoji = threatLevel === 'CRITICAL' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
  return [
    `${emoji} УГРОЗА: ${systemName} (${systemSec.toFixed(1)}) — ${jumpsAhead} прыжков впереди`,
    `${killCount} ганков недавно`,
    `Угроза для ${shipName}: ${threatLevel}`,
    reason,
  ].join('\n');
}

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
