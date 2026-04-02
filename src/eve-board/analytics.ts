/**
 * Route security analytics — Level 2.
 *
 * Pure analysis functions that transform raw route-monitoring data
 * (kills, jump counts, pilot location) into security insights:
 *
 *  1. Jump spike detection (fleet forming / massive movement)
 *  2. Gate-level kill attribution (nearest stargate per killmail)
 *  3. Kill velocity / active camp detection
 *  4. Per-system threat digest
 *  5. Full-route threat digest
 *  6. Telegram message formatter
 */

import type { Db } from '../db/sqlite.js';
import type {
  ThreatLevel,
  JumpSpike,
  GateKill,
  KillSummary,
  SystemThreatDigest,
  RouteThreatDigest,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gate camp proximity threshold: 200 km in meters (EVE uses meters). */
const GATE_CAMP_RADIUS_M = 200_000_000_000;

/** Threat level ordering for max-comparison. */
const THREAT_ORDER: Record<ThreatLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compare two threat levels, return the higher one. */
function maxThreat(a: ThreatLevel, b: ThreatLevel): ThreatLevel {
  return THREAT_ORDER[a] >= THREAT_ORDER[b] ? a : b;
}

/** Euclidean distance in 3-D space. */
function dist3d(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

/** Format security status like the game does: 0.5, -0.3, etc. */
function fmtSec(sec: number): string {
  return sec.toFixed(1);
}

/** Threat-level emoji. */
function threatEmoji(level: ThreatLevel): string {
  switch (level) {
    case 'LOW': return '🟢';
    case 'MEDIUM': return '🟡';
    case 'HIGH': return '🟠';
    case 'CRITICAL': return '🔴';
  }
}

/** Pluralise Russian "система" roughly. */
function systemWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'система';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'системы';
  return 'систем';
}

/** Pluralise "прыжок". */
function jumpWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'прыжок';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'прыжка';
  return 'прыжков';
}

/** Pluralise "килл" / "убийство" in short form. */
function killWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'килл';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'килла';
  return 'киллов';
}

// ---------------------------------------------------------------------------
// 1. Jump spike detection
// ---------------------------------------------------------------------------

/**
 * Compare two consecutive poll snapshots and detect systems with abnormal
 * jump-count increases (fleet forming / fleet movement / massive op).
 *
 * Thresholds:
 *   delta > 50   → elevated
 *   delta > 150  → fleet
 *   delta > 500  → massive
 *
 * Returns only non-normal spikes, sorted by delta descending.
 */
export function detectJumpSpikes(
  currentJumps: Map<number, number>,
  previousJumps: Map<number, number>,
  systemNames: Map<number, string>,
): JumpSpike[] {
  const spikes: JumpSpike[] = [];

  for (const [systemId, current] of currentJumps) {
    const previous = previousJumps.get(systemId) ?? 0;
    const delta = current - previous;

    if (delta <= 50) continue;

    let severity: JumpSpike['severity'];
    if (delta > 500) severity = 'massive';
    else if (delta > 150) severity = 'fleet';
    else severity = 'elevated';

    spikes.push({
      systemId,
      systemName: systemNames.get(systemId) ?? `System ${systemId}`,
      previousJumps: previous,
      currentJumps: current,
      delta,
      severity,
    });
  }

  spikes.sort((a, b) => b.delta - a.delta);
  return spikes;
}

// ---------------------------------------------------------------------------
// 2. Gate-level kill attribution
// ---------------------------------------------------------------------------

type StargateRow = {
  stargate_id: number;
  destination_system_id: number;
  data_json: string;
};

type StargatePos = {
  stargateId: number;
  destinationSystemId: number;
  position: { x: number; y: number; z: number };
};

/**
 * Attribute kills to the nearest stargate in the system.
 *
 * For each kill that has a position, find the closest stargate (3-D euclidean).
 * If the distance is within GATE_CAMP_RADIUS_M (200 km), attribute the kill
 * to that gate.  Group results by stargate, resolve destination system name.
 */
export function attributeKillsToGates(
  db: Db,
  systemId: number,
  kills: Array<{ position?: { x: number; y: number; z: number }; killmail_id: number; killmail_time?: string }>,
): GateKill[] {
  // Fetch stargates for this system
  const rows = db.prepare(
    'SELECT stargate_id, destination_system_id, data_json FROM sde_stargates WHERE system_id = ?',
  ).all(systemId) as StargateRow[];

  if (rows.length === 0) return [];

  // Parse stargate positions from data_json
  const gates: StargatePos[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as Record<string, unknown>;
      const pos = data['position'] as { x?: number; y?: number; z?: number } | undefined;
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number') {
        gates.push({
          stargateId: row.stargate_id,
          destinationSystemId: row.destination_system_id,
          position: { x: pos.x, y: pos.y, z: pos.z },
        });
      }
    } catch {
      // Malformed JSON — skip this gate
    }
  }

  if (gates.length === 0) return [];

  // Resolve system name for our system
  const systemNameRow = db.prepare(
    'SELECT name FROM sde_systems WHERE system_id = ?',
  ).get(systemId) as { name: string } | undefined;
  const systemName = systemNameRow?.name ?? `System ${systemId}`;

  // Attribute each kill to its nearest gate
  const gateKillMap = new Map<number, { gate: StargatePos; killIds: Set<number>; recentKills: number }>();

  const fiveMinAgo = Date.now() - 5 * 60_000;

  for (const kill of kills) {
    if (!kill.position) continue;

    let nearestGate: StargatePos | null = null;
    let nearestDist = Infinity;

    for (const gate of gates) {
      const d = dist3d(kill.position, gate.position);
      if (d < nearestDist) {
        nearestDist = d;
        nearestGate = gate;
      }
    }

    if (!nearestGate || nearestDist > GATE_CAMP_RADIUS_M) continue;

    let entry = gateKillMap.get(nearestGate.stargateId);
    if (!entry) {
      entry = { gate: nearestGate, killIds: new Set(), recentKills: 0 };
      gateKillMap.set(nearestGate.stargateId, entry);
    }
    entry.killIds.add(kill.killmail_id);

    // Count recent kills (last 5 min)
    if (kill.killmail_time) {
      const killTs = new Date(kill.killmail_time).getTime();
      if (killTs >= fiveMinAgo) {
        entry.recentKills++;
      }
    }
  }

  // Build result, resolving destination system names
  const result: GateKill[] = [];
  for (const [, entry] of gateKillMap) {
    const destRow = db.prepare(
      'SELECT name FROM sde_systems WHERE system_id = ?',
    ).get(entry.gate.destinationSystemId) as { name: string } | undefined;

    result.push({
      systemId,
      systemName,
      stargateId: entry.gate.stargateId,
      connectedSystemName: destRow?.name ?? `System ${entry.gate.destinationSystemId}`,
      killCount: entry.killIds.size,
      recentKills: entry.recentKills,
    });
  }

  // Sort by kill count descending
  result.sort((a, b) => b.killCount - a.killCount);
  return result;
}

// ---------------------------------------------------------------------------
// 3. Kill velocity (timeline analysis)
// ---------------------------------------------------------------------------

/**
 * Analyse the kill rate within a time window to detect active gate camps.
 *
 * @param kills       Kills with optional timestamps.
 * @param windowMinutes  How far back to look (e.g. 15).
 * @returns velocity (kills/min), active-camp flag, camp duration.
 */
export function analyzeKillVelocity(
  kills: Array<{ killmail_time?: string }>,
  windowMinutes: number,
): { velocity: number; isActiveCamp: boolean; campDuration: number } {
  const now = Date.now();
  const windowStart = now - windowMinutes * 60_000;

  // Filter kills within the time window
  const timestamps: number[] = [];
  for (const kill of kills) {
    if (!kill.killmail_time) continue;
    const ts = new Date(kill.killmail_time).getTime();
    if (ts >= windowStart && ts <= now) {
      timestamps.push(ts);
    }
  }

  if (timestamps.length === 0) {
    return { velocity: 0, isActiveCamp: false, campDuration: 0 };
  }

  timestamps.sort((a, b) => a - b);

  const velocity = timestamps.length / windowMinutes;
  const isActiveCamp = velocity >= 0.5; // 1 kill per 2 minutes = active camp
  const campDuration = (timestamps[timestamps.length - 1]! - timestamps[0]!) / 60_000;

  return {
    velocity: Math.round(velocity * 100) / 100,
    isActiveCamp,
    campDuration: Math.round(campDuration * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// 4. System threat digest builder
// ---------------------------------------------------------------------------

/**
 * Build a complete threat digest for a single system by combining all
 * available analytics: kill velocity, jump spikes, gate attribution, gankers.
 */
export function buildSystemDigest(
  systemId: number,
  systemName: string,
  systemSec: number,
  jumpsFromPilot: number,
  threatLevel: ThreatLevel,
  reason: string,
  kills: Array<{
    killmail_time?: string;
    killmail_id: number;
    position?: { x: number; y: number; z: number };
    // Enriched fields from KilllistItem
    ship_name?: string;
    victim_character_name?: string;
    final_blow_character_name?: string;
    total_value?: number;
    attacker_count?: number;
    is_solo?: boolean;
  }>,
  jumpSpike: JumpSpike | null,
  gankerCount: number,
  db: Db,
): SystemThreatDigest {
  // Kill velocity over 15-minute window
  const { velocity } = analyzeKillVelocity(kills, 15);

  // Gate-level kill attribution
  const gateKills = attributeKillsToGates(db, systemId, kills);

  // Build kill summaries for LLM context (max 5)
  const recentKills: KillSummary[] = kills.slice(0, 5).map((k) => {
    const t = k.killmail_time ? new Date(k.killmail_time) : new Date();
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    return {
      time: `${hh}:${mm}`,
      victimShip: k.ship_name ?? '?',
      victimName: k.victim_character_name ?? '?',
      attackerShip: '?', // FB ship resolved in monitor
      attackerName: k.final_blow_character_name ?? '?',
      attackerCount: k.attacker_count ?? 1,
      valueMISK: Math.round((k.total_value ?? 0) / 1_000_000),
      solo: k.is_solo ?? false,
    };
  });

  return {
    systemId,
    systemName,
    systemSec,
    jumpsFromPilot,
    threatLevel,
    reason,
    killVelocity: velocity,
    jumpSpike,
    gateKills,
    gankerCount,
    recentKills,
  };
}

// ---------------------------------------------------------------------------
// 5. Route threat digest builder
// ---------------------------------------------------------------------------

/**
 * Build the full-route threat digest from per-system digests.
 *
 * Overall threat = max across all systems.
 * Summary = compact Russian text overview.
 */
export function buildRouteThreatDigest(
  pilotSystem: string,
  pilotSystemIdx: number,
  totalRouteSystems: number,
  origin: string,
  destination: string,
  systemsAhead: SystemThreatDigest[],
  systemsBehind: SystemThreatDigest[],
): RouteThreatDigest {
  // Overall threat: max across all systems
  let overallThreat: ThreatLevel = 'LOW';
  for (const s of [...systemsAhead, ...systemsBehind]) {
    overallThreat = maxThreat(overallThreat, s.threatLevel);
  }

  const summary = buildSummaryText(overallThreat, systemsAhead, systemsBehind);

  return {
    timestamp: new Date().toISOString(),
    pilotSystem,
    pilotSystemIdx,
    totalRouteSystems,
    origin,
    destination,
    systemsAhead,
    systemsBehind,
    overallThreat,
    summary,
  };
}

/**
 * Build a compact Russian-language summary line for the digest.
 */
function buildSummaryText(
  overallThreat: ThreatLevel,
  ahead: SystemThreatDigest[],
  behind: SystemThreatDigest[],
): string {
  const allSystems = [...ahead, ...behind];
  const totalCount = allSystems.length;

  // Count dangerous systems (MEDIUM+)
  const dangerSystems = allSystems.filter(s => THREAT_ORDER[s.threatLevel] >= THREAT_ORDER['MEDIUM']);

  if (dangerSystems.length === 0) {
    return `${threatEmoji('LOW')} Маршрут безопасен — ${totalCount} ${systemWord(totalCount)} без активности`;
  }

  // Build per-system short descriptions for dangerous systems
  const parts: string[] = [];
  for (const s of dangerSystems) {
    const snippets: string[] = [];

    // Kill info
    if (s.killVelocity > 0) {
      const killsInWindow = Math.round(s.killVelocity * 15); // approximate kills in 15 min
      snippets.push(`${killsInWindow} PvP за 15 мин`);
    }

    // Gate camp info
    if (s.gateKills.length > 0) {
      const topGate = s.gateKills[0]!;
      snippets.push(`гейт ${topGate.connectedSystemName}: ${topGate.killCount} ${killWord(topGate.killCount)}`);
    }

    // Jump spike info
    if (s.jumpSpike) {
      snippets.push(`+${s.jumpSpike.delta} ${jumpWord(s.jumpSpike.delta)}`);
    }

    // Ganker info
    if (s.gankerCount > 0) {
      snippets.push(`${s.gankerCount} ганкеров`);
    }

    const detail = snippets.length > 0 ? snippets.join(', ') : s.reason;
    parts.push(`${s.systemName}: ${detail}`);
  }

  const safeCount = totalCount - dangerSystems.length;
  const safeSuffix = safeCount > 0
    ? ` | остальные ${safeCount} ${systemWord(safeCount)} тихо`
    : '';

  return `${threatEmoji(overallThreat)} ${parts.join(' | ')}${safeSuffix}`;
}

// ---------------------------------------------------------------------------
// 6. Threat digest formatter (Telegram message)
// ---------------------------------------------------------------------------

/**
 * Format a RouteThreatDigest as a plain-text Telegram message in Russian.
 */
export function formatThreatDigest(digest: RouteThreatDigest): string {
  const lines: string[] = [];

  // Header: overall route status
  const pilotIdx = digest.pilotSystemIdx + 1; // 1-based for display

  lines.push(`📊 ${digest.origin} → ${digest.destination} | Вы в: ${digest.pilotSystem} (${pilotIdx}/${digest.totalRouteSystems})`);
  lines.push('');

  // Behind section
  if (digest.systemsBehind.length > 0) {
    const behindDanger = digest.systemsBehind.filter(s => THREAT_ORDER[s.threatLevel] >= THREAT_ORDER['MEDIUM']);
    if (behindDanger.length === 0) {
      lines.push(`🟢 Позади (${digest.systemsBehind.length} ${systemWord(digest.systemsBehind.length)}): тихо`);
    } else {
      const behindMax = behindDanger.reduce<ThreatLevel>((acc, s) => maxThreat(acc, s.threatLevel), 'LOW');
      lines.push(`${threatEmoji(behindMax)} Позади (${digest.systemsBehind.length} ${systemWord(digest.systemsBehind.length)}):`);
      for (const s of behindDanger) {
        lines.push(formatSystemLine(s));
      }
    }
  }

  // Ahead section
  if (digest.systemsAhead.length > 0) {
    const aheadDanger = digest.systemsAhead.filter(s => THREAT_ORDER[s.threatLevel] >= THREAT_ORDER['MEDIUM']);
    if (aheadDanger.length === 0) {
      lines.push(`🟢 Впереди (${digest.systemsAhead.length} ${systemWord(digest.systemsAhead.length)}): тихо`);
    } else {
      const aheadMax = aheadDanger.reduce<ThreatLevel>((acc, s) => maxThreat(acc, s.threatLevel), 'LOW');
      lines.push(`${threatEmoji(aheadMax)} Впереди (${digest.systemsAhead.length} ${systemWord(digest.systemsAhead.length)}):`);
      for (const s of aheadDanger) {
        lines.push(formatSystemLine(s));
      }
      const safeCount = digest.systemsAhead.length - aheadDanger.length;
      if (safeCount > 0) {
        lines.push(`  🟢 Остальные ${safeCount} ${systemWord(safeCount)} безопасны`);
      }
    }
  }

  // Timestamp
  lines.push('');
  const ts = new Date(digest.timestamp);
  const hh = String(ts.getUTCHours()).padStart(2, '0');
  const mm = String(ts.getUTCMinutes()).padStart(2, '0');
  lines.push(`${hh}:${mm} UTC`);

  return lines.join('\n');
}

/**
 * Format a single dangerous system as an indented line.
 */
function formatSystemLine(s: SystemThreatDigest): string {
  const parts: string[] = [];

  // Kill velocity
  if (s.killVelocity > 0) {
    const killsInWindow = Math.round(s.killVelocity * 15);
    parts.push(`${killsInWindow} PvP за 15 мин`);
  }

  // Reason (if no kill velocity info)
  if (parts.length === 0 && s.reason) {
    parts.push(s.reason);
  }

  const jumpsStr = `${Math.abs(s.jumpsFromPilot)} ${jumpWord(Math.abs(s.jumpsFromPilot))}`;
  const header = `  ${threatEmoji(s.threatLevel)} ${s.systemName} (${fmtSec(s.systemSec)}) — ${jumpsStr} | ${parts.join(', ')}`;

  // Sub-details: gate kills and jump spikes
  const subLines: string[] = [];

  for (const gk of s.gateKills) {
    subLines.push(`     Гейт ${gk.connectedSystemName}: ${gk.killCount} ${killWord(gk.killCount)}`);
  }

  if (s.jumpSpike) {
    subLines.push(`     +${s.jumpSpike.delta} ${jumpWord(s.jumpSpike.delta)}`);
  }

  if (s.gankerCount > 0) {
    subLines.push(`     ${s.gankerCount} известных ганкеров`);
  }

  return subLines.length > 0
    ? header + '\n' + subLines.join('\n')
    : header;
}
