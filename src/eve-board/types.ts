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

// ---------------------------------------------------------------------------
// Level 1: Extended route scan state
// ---------------------------------------------------------------------------

/** Per-system snapshot taken each poll cycle */
export type SystemSnapshot = {
  systemId: number;
  systemName: string;
  systemSec: number;
  /** ship_jumps from ESI get_universe_system_jumps (hourly aggregate) */
  shipJumps: number;
  /** ship_kills + pod_kills from ESI get_universe_system_kills */
  pvpKills: number;
  /** Relative position: negative = behind pilot, positive = ahead */
  jumpsFromPilot: number;
  /** Timestamp of this snapshot */
  timestamp: number;
};

/** Route-level watch: auto-subscribed R2Z2 topics while monitor is active */
export type RouteWatch = {
  chatId: number;
  systemIds: number[];
  topics: string[];        // 'system.{id}' topics registered with kill_watches
};

// ---------------------------------------------------------------------------
// Level 2: Analytics
// ---------------------------------------------------------------------------

/** Jump spike: traffic change between consecutive polls */
export type JumpSpike = {
  systemId: number;
  systemName: string;
  previousJumps: number;
  currentJumps: number;
  delta: number;
  /** Spike significance: normal traffic | elevated | fleet forming | massive */
  severity: 'normal' | 'elevated' | 'fleet' | 'massive';
};

/** Gate-level kill attribution (kill near a specific stargate) */
export type GateKill = {
  systemId: number;
  systemName: string;
  stargateId: number;
  /** Name of the connected system (the "from" direction) */
  connectedSystemName: string;
  killCount: number;
  recentKills: number;     // kills in last 5 min
};

/** Compact kill summary for LLM context */
export type KillSummary = {
  time: string;           // "12:05 UTC"
  victimShip: string;     // "Badger"
  victimName: string;     // "SlayerBoxer6" or "?"
  attackerShip: string;   // "Tornado"
  attackerName: string;   // "GankerMcStab" or "?"
  attackerCount: number;
  valueMISK: number;
  solo: boolean;
};

/** Per-system threat analysis combining kills + jumps + time */
export type SystemThreatDigest = {
  systemId: number;
  systemName: string;
  systemSec: number;
  jumpsFromPilot: number;
  threatLevel: ThreatLevel;
  /** Compact reason string */
  reason: string;
  killVelocity: number;    // kills per minute in recent window
  jumpSpike: JumpSpike | null;
  gateKills: GateKill[];
  gankerCount: number;     // known gankers from cache
  /** Recent kills for LLM analysis context */
  recentKills: KillSummary[];
};

/** Full route threat digest sent to user */
export type RouteThreatDigest = {
  timestamp: string;
  pilotSystem: string;
  pilotSystemIdx: number;
  /** Total systems in the full route (not just scanned) */
  totalRouteSystems: number;
  /** Origin system name */
  origin: string;
  /** Destination system name */
  destination: string;
  systemsAhead: SystemThreatDigest[];
  systemsBehind: SystemThreatDigest[];
  overallThreat: ThreatLevel;
  summary: string;
};

// ---------------------------------------------------------------------------
// Level 3: Intelligence
// ---------------------------------------------------------------------------

/** Pursuit detection: kills behind pilot moving in pilot's direction */
export type PursuitSignal = {
  /** Systems behind where recent kills appeared */
  systemIds: number[];
  /** Are the kill systems getting closer to pilot? */
  approachingPilot: boolean;
  /** Time window of detected pattern */
  windowMinutes: number;
  /** Confidence: low | medium | high */
  confidence: 'low' | 'medium' | 'high';
};

/** LLM-generated route intelligence summary */
export type RouteIntelSummary = {
  timestamp: string;
  recommendation: 'STOP' | 'WAIT' | 'PROCEED' | 'REROUTE';
  /** Human-readable advice in Russian */
  advice: string;
  /** If REROUTE, suggested alternative */
  alternativeVia?: string;
  /** Key factors driving the recommendation */
  factors: string[];
  pursuit: PursuitSignal | null;
};
