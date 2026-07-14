/**
 * Threat assessment engine for route intelligence.
 *
 * Pure code logic — no LLM calls.  Analyzes kill patterns from eve-kill
 * and ship vulnerability from SDE dogma to produce threat scores.
 */

import type { Db } from '../db/sqlite.js';
import type { ThreatLevel, KillPattern, ShipAssessment, ThreatKillmail } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hauler / freighter group names in SDE */
const HAULER_GROUPS = new Set([
  'Industrial',
  'Deep Space Transport',
  'Blockade Runner',
  'Freighter',
  'Jump Freighter',
]);

/** Mining ship group names */
const MINING_GROUPS = new Set([
  'Mining Barge',
  'Exhumer',
  'Industrial Command Ship',
]);

/** All high-value-target groups combined */
const HIGH_VALUE_GROUPS = new Set([...HAULER_GROUPS, ...MINING_GROUPS]);

/** Avg gank-fit DPS per pilot (Catalyst baseline) */
const AVG_GANK_DPS = 400;

/** CONCORD response window in seconds (highsec 0.5–1.0) */
const CONCORD_RESPONSE_FAST = 20;
const CONCORD_RESPONSE_SLOW = 25;

/** Gank fleet activity: kills within this many minutes = "active" */
const ACTIVE_FLEET_WINDOW_MIN = 15;

// ---------------------------------------------------------------------------
// Dogma attribute resolver (internal)
// ---------------------------------------------------------------------------

type DogmaRow = { name: string; val: number | null };

/**
 * Fetch a set of dogma attribute values for a given type_id.
 * Uses the canonical SDE join pattern from tools.ts SDE_SCHEMA.
 */
function getDogmaAttributes(db: Db, typeId: number, names: string[]): Map<string, number> {
  if (names.length === 0) return new Map();

  const placeholders = names.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT a.name, json_extract(j.value, '$.value') AS val
    FROM sde_type_dogma d, json_each(d.data_json, '$.dogmaAttributes') j
    JOIN sde_dogma_attributes a ON a.attribute_id = json_extract(j.value, '$.attributeID')
    WHERE d.type_id = ? AND a.name IN (${placeholders})
  `).all(typeId, ...names) as DogmaRow[];

  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.val !== null && row.val !== undefined) {
      result.set(row.name, Number(row.val));
    }
  }
  return result;
}

/**
 * Get mass from sde_types.data_json (not a dogma attribute).
 */
function getTypeMass(db: Db, typeId: number): number | null {
  const row = db.prepare(
    "SELECT json_extract(data_json, '$.mass') AS mass FROM sde_types WHERE type_id = ?",
  ).get(typeId) as { mass: number | null } | undefined;
  return row?.mass ?? null;
}

/**
 * Get type name and group name for a ship.
 */
function getTypeGroupInfo(
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
// 1. assessShip
// ---------------------------------------------------------------------------

/**
 * Calculate ship vulnerability from SDE dogma data.
 *
 * EHP calculation uses the best-case (lowest) resist resonance per layer:
 *   layer_ehp = hp / (1 - best_resist)  where resist = 1 - resonance
 *   so layer_ehp = hp / min_resonance
 *
 * Total EHP = shield_ehp + armor_ehp + hull_hp (hull has no meaningful resists in base stats)
 *
 * Align time:  -ln(0.25) * agility * mass / 1_000_000
 * Warp speed:  warpSpeedMultiplier (default 3 AU/s)
 */
export function assessShip(db: Db, shipTypeId: number): ShipAssessment {
  const info = getTypeGroupInfo(db, shipTypeId);
  const shipName = info?.typeName ?? `Type ${shipTypeId}`;
  const groupName = info?.groupName ?? '';

  // Dogma attributes we need
  const attrs = getDogmaAttributes(db, shipTypeId, [
    'shieldCapacity',
    'shieldEmDamageResonance',
    'shieldThermalDamageResonance',
    'shieldKineticDamageResonance',
    'shieldExplosiveDamageResonance',
    'armorHP',
    'armorEmDamageResonance',
    'armorThermalDamageResonance',
    'armorKineticDamageResonance',
    'armorExplosiveDamageResonance',
    'hp',
    'agility',
    'warpSpeedMultiplier',
  ]);

  const mass = getTypeMass(db, shipTypeId);

  // Shield EHP
  const shieldHp = attrs.get('shieldCapacity') ?? 0;
  const shieldMinResonance = Math.min(
    attrs.get('shieldEmDamageResonance') ?? 1,
    attrs.get('shieldThermalDamageResonance') ?? 1,
    attrs.get('shieldKineticDamageResonance') ?? 1,
    attrs.get('shieldExplosiveDamageResonance') ?? 1,
  );
  const shieldEhp = shieldMinResonance > 0 ? shieldHp / shieldMinResonance : shieldHp;

  // Armor EHP
  const armorHp = attrs.get('armorHP') ?? 0;
  const armorMinResonance = Math.min(
    attrs.get('armorEmDamageResonance') ?? 1,
    attrs.get('armorThermalDamageResonance') ?? 1,
    attrs.get('armorKineticDamageResonance') ?? 1,
    attrs.get('armorExplosiveDamageResonance') ?? 1,
  );
  const armorEhp = armorMinResonance > 0 ? armorHp / armorMinResonance : armorHp;

  // Hull (raw, no meaningful base resists)
  const hullHp = attrs.get('hp') ?? 0;

  const ehp = Math.round(shieldEhp + armorEhp + hullHp);

  // Align time: -ln(0.25) * agility * mass / 1_000_000
  const agility = attrs.get('agility') ?? 1;
  const shipMass = mass ?? 10_000_000;
  const alignTime = -Math.log(0.25) * agility * shipMass / 1_000_000;

  // Warp speed
  const warpSpeed = attrs.get('warpSpeedMultiplier') ?? 3;

  // Ship class
  const shipClass = classifyShipGroup(groupName);

  // High value target?
  const isHighValueTarget = HIGH_VALUE_GROUPS.has(groupName);

  // Survival chance based on raw EHP
  const survivalChance = ehpToSurvivalChance(ehp);

  return {
    shipTypeId,
    shipName,
    ehp,
    alignTime: Math.round(alignTime * 100) / 100,
    warpSpeed: Math.round(warpSpeed * 100) / 100,
    shipClass,
    isHighValueTarget,
    survivalChance,
  };
}

function classifyShipGroup(groupName: string): string {
  if (HAULER_GROUPS.has(groupName)) return 'hauler';
  if (MINING_GROUPS.has(groupName)) return 'mining';

  // Map common group names to simpler class labels
  const GROUP_CLASS_MAP: Record<string, string> = {
    'Frigate': 'frigate',
    'Assault Frigate': 'assault_frigate',
    'Interceptor': 'interceptor',
    'Covert Ops': 'covert_ops',
    'Electronic Attack Ship': 'ewar_frigate',
    'Stealth Bomber': 'stealth_bomber',
    'Destroyer': 'destroyer',
    'Interdictor': 'interdictor',
    'Tactical Destroyer': 'tactical_destroyer',
    'Cruiser': 'cruiser',
    'Heavy Assault Cruiser': 'heavy_assault',
    'Recon Ship': 'recon',
    'Heavy Interdiction Cruiser': 'hictor',
    'Strategic Cruiser': 'strategic_cruiser',
    'Logistics Cruiser': 'logistics',
    'Battlecruiser': 'battlecruiser',
    'Command Ship': 'command_ship',
    'Battleship': 'battleship',
    'Marauder': 'marauder',
    'Black Ops': 'black_ops',
    'Dreadnought': 'capital',
    'Carrier': 'capital',
    'Supercarrier': 'super_capital',
    'Titan': 'super_capital',
    'Force Auxiliary': 'capital',
    'Shuttle': 'shuttle',
    'Capsule': 'capsule',
    'Corvette': 'corvette',
  };

  return GROUP_CLASS_MAP[groupName] ?? 'other';
}

function ehpToSurvivalChance(ehp: number): ShipAssessment['survivalChance'] {
  if (ehp < 10_000) return 'DEAD';
  if (ehp < 30_000) return 'UNLIKELY';
  if (ehp < 80_000) return 'POSSIBLE';
  return 'SAFE';
}

// ---------------------------------------------------------------------------
// 2. analyzeKillPattern
// ---------------------------------------------------------------------------

/**
 * Analyze a list of kills in a system to extract attack patterns.
 */
export function analyzeKillPattern(
  kills: ThreatKillmail[],
  systemId: number,
  systemName: string,
  systemSec: number,
): KillPattern {
  const uniqueAttackers = new Set<number>();
  const attackerShipTypes = new Map<number, number>();
  const victimShipGroups: string[] = [];
  let isNpcOnly = true;
  let latestKillTime = '';
  let earliestKillTime = '';

  for (const kill of kills) {
    // Track attacker characters
    if (kill.final_blow_character_id) {
      uniqueAttackers.add(kill.final_blow_character_id);
    }

    // NPC check
    if (kill.is_npc !== true) {
      isNpcOnly = false;
    }

    // Victim ship group classification
    const victimGroup = classifyVictimShip(kill.ship_group_name);
    if (victimGroup) {
      victimShipGroups.push(victimGroup);
    }

    // Time window tracking
    const killTime = kill.killmail_time ?? '';
    if (killTime) {
      if (!latestKillTime || killTime > latestKillTime) latestKillTime = killTime;
      if (!earliestKillTime || killTime < earliestKillTime) earliestKillTime = killTime;
    }
  }

  // Calculate time window in minutes
  let timeWindowMinutes = 0;
  if (latestKillTime && earliestKillTime) {
    const latest = new Date(latestKillTime).getTime();
    const earliest = new Date(earliestKillTime).getTime();
    timeWindowMinutes = Math.max(0, Math.round((latest - earliest) / 60_000));
  }

  // Estimate gank DPS from unique attacker count
  const estimatedGankDps = uniqueAttackers.size * AVG_GANK_DPS;

  return {
    systemId,
    systemName,
    systemSec,
    killCount: kills.length,
    timeWindowMinutes,
    uniqueAttackers,
    attackerShipTypes,
    victimShipGroups,
    estimatedGankDps,
    isNpcOnly,
    latestKillTime,
  };
}

function classifyVictimShip(groupName: string | undefined): string | null {
  if (!groupName) return null;
  if (HAULER_GROUPS.has(groupName)) return 'hauler';
  if (MINING_GROUPS.has(groupName)) return 'mining';
  return 'other';
}

// ---------------------------------------------------------------------------
// 3. scoreThreat
// ---------------------------------------------------------------------------

/**
 * Score the threat based on kill pattern + user's ship assessment.
 *
 * Levels:
 * - CRITICAL: active gank fleet + user is high-value + EHP < DPS * CONCORD fast response
 * - HIGH: active gank fleet + victim type matches OR EHP < DPS * CONCORD slow response
 * - MEDIUM: some kills but not matching, or old activity
 * - LOW: NPC only, no recent kills, or user in a tanky ship
 */
export function scoreThreat(
  pattern: KillPattern,
  ship: ShipAssessment,
): { level: ThreatLevel; reason: string } {
  // No kills at all
  if (pattern.killCount === 0) {
    return { level: 'LOW', reason: 'Нет убийств в системе' };
  }

  // NPC kills only
  if (pattern.isNpcOnly) {
    return { level: 'LOW', reason: 'Только NPC убийства, игроки не замечены' };
  }

  // Check if gank fleet is active (3+ kills within ACTIVE_FLEET_WINDOW_MIN)
  const isActiveFleet = pattern.uniqueAttackers.size >= 3
    && pattern.timeWindowMinutes <= ACTIVE_FLEET_WINDOW_MIN
    && pattern.killCount >= 3;

  // Check if kills are recent (within 15 minutes of now)
  const minutesSinceLastKill = pattern.latestKillTime
    ? Math.max(0, (Date.now() - new Date(pattern.latestKillTime).getTime()) / 60_000)
    : Infinity;
  const isRecent = minutesSinceLastKill <= ACTIVE_FLEET_WINDOW_MIN;

  // Check if victim types match user's ship class
  const haulersKilled = pattern.victimShipGroups.filter(g => g === 'hauler').length;
  const minersKilled = pattern.victimShipGroups.filter(g => g === 'mining').length;
  const matchesUserType = (ship.shipClass === 'hauler' && haulersKilled > 0)
    || (ship.shipClass === 'mining' && minersKilled > 0)
    || ship.isHighValueTarget;

  // EHP thresholds against estimated gank DPS
  const ehpVsConcordFast = pattern.estimatedGankDps * CONCORD_RESPONSE_FAST;
  const ehpVsConcordSlow = pattern.estimatedGankDps * CONCORD_RESPONSE_SLOW;

  // CRITICAL: active gank fleet + high-value target + can't survive CONCORD fast response
  if (isActiveFleet && isRecent && ship.isHighValueTarget && ship.ehp < ehpVsConcordFast) {
    return {
      level: 'CRITICAL',
      reason: `Активный ганк-флот (${pattern.uniqueAttackers.size} пилотов, `
        + `${pattern.killCount} убийств за ${pattern.timeWindowMinutes} мин). `
        + `Ваш ${ship.shipName} (${ship.ehp} EHP) не переживёт ${pattern.estimatedGankDps} DPS`,
    };
  }

  // HIGH: active fleet + matching victims OR low EHP vs estimated DPS
  if (isActiveFleet && isRecent && (matchesUserType || ship.ehp < ehpVsConcordSlow)) {
    return {
      level: 'HIGH',
      reason: `Ганк-флот активен (${pattern.uniqueAttackers.size} атакующих). `
        + (matchesUserType
          ? `Убивают ${haulersKilled > 0 ? 'хаулеров' : 'шахтёров'} — ваш тип корабля в зоне риска`
          : `Ваш EHP (${ship.ehp}) ниже порога выживания`),
    };
  }

  // MEDIUM: some activity but not matching or not recent
  if (pattern.killCount >= 2 || (isRecent && pattern.killCount >= 1)) {
    return {
      level: 'MEDIUM',
      reason: `Замечена активность (${pattern.killCount} убийств, `
        + `последнее ${Math.round(minutesSinceLastKill)} мин назад)`,
    };
  }

  // LOW: minimal activity
  return {
    level: 'LOW',
    reason: pattern.killCount === 1
      ? `Единичное убийство ${Math.round(minutesSinceLastKill)} мин назад`
      : 'Низкая угроза',
  };
}

// ---------------------------------------------------------------------------
// 4. detectGankWindow
// ---------------------------------------------------------------------------

/**
 * Detect when it is safe to pass through a system based on kill patterns.
 *
 * After a series of kills, gankers need to wait out security status / CONCORD.
 * A gap of 15+ min after activity = "window open".
 */
export function detectGankWindow(
  patterns: KillPattern[],
): { isOpen: boolean; reason: string } {
  // No patterns at all = safe
  if (patterns.length === 0) {
    return { isOpen: true, reason: 'Нет данных о ганк-активности — безопасно' };
  }

  // Find the most recent kill across all patterns
  let latestKillTime = '';
  let hasPlayerKills = false;

  for (const p of patterns) {
    if (!p.isNpcOnly) hasPlayerKills = true;
    if (p.latestKillTime && (!latestKillTime || p.latestKillTime > latestKillTime)) {
      latestKillTime = p.latestKillTime;
    }
  }

  // No player kills = safe
  if (!hasPlayerKills) {
    return { isOpen: true, reason: 'Только NPC активность — безопасно' };
  }

  // No timestamps available
  if (!latestKillTime) {
    return { isOpen: false, reason: 'Есть убийства, но нет данных о времени — осторожно' };
  }

  const minutesSinceLastKill = (Date.now() - new Date(latestKillTime).getTime()) / 60_000;

  // Kills still happening
  if (minutesSinceLastKill < 5) {
    return {
      isOpen: false,
      reason: `Убийства продолжаются (последнее ${Math.round(minutesSinceLastKill)} мин назад)`,
    };
  }

  // 5-15 min gap — uncertain
  if (minutesSinceLastKill < ACTIVE_FLEET_WINDOW_MIN) {
    return {
      isOpen: false,
      reason: `Ганкеры затихли ${Math.round(minutesSinceLastKill)} мин назад — ещё рано, подождите`,
    };
  }

  // 15+ min gap after activity = window open
  return {
    isOpen: true,
    reason: `Ганкеры неактивны ${Math.round(minutesSinceLastKill)}+ мин, окно для прохода`,
  };
}

// ---------------------------------------------------------------------------
// 5. updateGankerCache
// ---------------------------------------------------------------------------

/**
 * Track known active gankers in the route_ganker_cache table.
 *
 * For each kill, extract the final-blow character and upsert:
 * increment kill_count, update last_seen.
 */
export function updateGankerCache(
  db: Db,
  kills: ThreatKillmail[],
  systemId: number,
): void {
  const stmt = db.prepare(`
    INSERT INTO route_ganker_cache (character_id, system_id, character_name, kill_count, last_seen, ship_type_id)
    VALUES (?, ?, ?, 1, datetime('now'), ?)
    ON CONFLICT (character_id, system_id) DO UPDATE SET
      kill_count = kill_count + 1,
      last_seen = datetime('now'),
      character_name = COALESCE(excluded.character_name, character_name),
      ship_type_id = COALESCE(excluded.ship_type_id, ship_type_id)
  `);

  const upsertMany = db.transaction((items: ThreatKillmail[]) => {
    for (const kill of items) {
      const charId = kill.final_blow_character_id;
      if (!charId) continue;
      // Skip NPC kills
      if (kill.is_npc) continue;

      const charName = kill.final_blow_character_name ?? '';
      // Killlist items don't carry attacker ship_type_id; use null
      const shipTypeId: number | null = null;

      stmt.run(charId, systemId, charName, shipTypeId);
    }
  });

  upsertMany(kills);
}
