/**
 * EVE-Board route intelligence types.
 *
 * RouteMonitor / RouteStats / GankerEntry are DB-backed (see route_monitors,
 * route_ganker_cache tables in migrations.ts).
 *
 * KillPattern, ShipAssessment, RouteBriefing, RouteReport are in-memory
 * analysis structures produced by the threat-assessment and briefing layers.
 */

// ---------------------------------------------------------------------------
// Threat level
// ---------------------------------------------------------------------------

export type ThreatLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// ---------------------------------------------------------------------------
// Route monitor state (persisted in DB)
// ---------------------------------------------------------------------------

export type RouteMonitor = {
  chatId: number;
  characterId: number;
  originId: number;
  destinationId: number;
  routeSystems: number[];        // ordered system IDs along route
  currentSystemId: number;       // where pilot is now
  shipTypeId: number;
  shipName: string;
  shipEhp: number;              // calculated from dogma
  startedAt: string;            // ISO timestamp
  lastLocationCheck: string;
  lastOnlineCheck: string;
  stats: RouteStats;
};

export type RouteStats = {
  killsSeen: number;            // total kills observed on route during flight
  jumpsCompleted: number;
  startTime: string;
  systemTimes: Record<number, number>; // system_id → ms spent
  dangerEvents: DangerEvent[];
};

export type DangerEvent = {
  systemId: number;
  systemName: string;
  time: string;
  threatLevel: ThreatLevel;
  description: string;
};

// ---------------------------------------------------------------------------
// Kill pattern for threat analysis
// ---------------------------------------------------------------------------

export type KillPattern = {
  systemId: number;
  systemName: string;
  systemSec: number;
  killCount: number;
  timeWindowMinutes: number;
  uniqueAttackers: Set<number>;          // attacker char IDs
  attackerShipTypes: Map<number, number>; // ship_type_id → count
  victimShipGroups: string[];            // e.g. ["hauler", "mining barge"]
  estimatedGankDps: number;
  isNpcOnly: boolean;
  latestKillTime: string;
};

// ---------------------------------------------------------------------------
// Ganker cache entry (persisted in DB)
// ---------------------------------------------------------------------------

export type GankerEntry = {
  characterId: number;
  characterName: string;
  systemId: number;
  killCount: number;
  lastSeen: string;
  shipTypeId: number;
};

// ---------------------------------------------------------------------------
// Ship vulnerability assessment
// ---------------------------------------------------------------------------

export type ShipAssessment = {
  shipTypeId: number;
  shipName: string;
  ehp: number;
  alignTime: number;    // seconds
  warpSpeed: number;    // AU/s
  shipClass: string;    // 'hauler' | 'mining_barge' | 'battleship' | etc.
  isHighValueTarget: boolean;  // haulers, freighters, mining barges
  survivalChance: 'DEAD' | 'UNLIKELY' | 'POSSIBLE' | 'SAFE';
};

// ---------------------------------------------------------------------------
// Briefing result
// ---------------------------------------------------------------------------

export type RouteBriefing = {
  origin: string;
  destination: string;
  jumps: number;
  dangerSystems: Array<{
    name: string;
    sec: number;
    killsLastHour: number;
    gankFleetActive: boolean;
    threatToUser: ThreatLevel;
  }>;
  shipAssessment: ShipAssessment;
  alternativeRoute: string | null;  // description of safer route if exists
  recommendation: string;           // overall advice
};

// ---------------------------------------------------------------------------
// Post-route report
// ---------------------------------------------------------------------------

export type RouteReport = {
  origin: string;
  destination: string;
  duration: number;      // ms
  jumpsTotal: number;
  killsOnRoute: number;
  dangerEvents: DangerEvent[];
  closestCall: DangerEvent | null;
  rating: 'SAFE' | 'CLOSE_CALL' | 'DANGEROUS';
};
