import type { Db } from '../db/sqlite.js';
import type { OsintKillmail } from './types.js';

export type ShipEntry = {
  ship_type_id: number;
  ship_name: string;
  hull_class: string;
  times_flown: number;
  kills_in: number;
  losses_in: number;
};

export type ShipProfile = {
  ships: ShipEntry[];
  favorite_ship: string | null;
  dominant_hull_class: string | null;
  ship_diversity: number;
  capital_usage: boolean;
  total_flights: number;
};

export type FleetProfile = {
  avg_fleet_size: number;
  median_fleet_size: number;
  solo_ratio: number;
  small_gang_ratio: number;
  medium_fleet_ratio: number;
  large_fleet_ratio: number;
  frequent_companions: Array<{
    character_id: number;
    character_name: string;
    shared_kills: number;
  }>;
  total_kills_analyzed: number;
};

type ShipSdeRow = {
  type_id: number;
  name: string | null;
  group_name: string | null;
};

const CAPITAL_GROUPS = new Set([
  'Carrier',
  'Dreadnought',
  'Force Auxiliary',
  'Supercarrier',
  'Titan',
]);

const SCOPE_KEY: Record<'character' | 'corporation' | 'alliance', keyof OsintKillmail['attackers'][number]> = {
  character: 'character_id',
  corporation: 'corporation_id',
  alliance: 'alliance_id',
};

function resolveShipNames(
  db: Db,
  typeIds: Set<number>,
): Map<number, { name: string; group_name: string }> {
  const result = new Map<number, { name: string; group_name: string }>();
  if (typeIds.size === 0) return result;

  const ids = [...typeIds];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT t.type_id, t.name, g.name AS group_name
     FROM sde_types t
     LEFT JOIN sde_groups g ON g.group_id = t.group_id
     WHERE t.type_id IN (${placeholders})`,
  ).all(...ids) as ShipSdeRow[];

  for (const row of rows) {
    result.set(row.type_id, {
      name: row.name ?? 'Unknown',
      group_name: row.group_name ?? 'Unknown',
    });
  }
  return result;
}

export function analyzeShipProfile(
  db: Db,
  kills: OsintKillmail[],
  scope: 'character' | 'corporation' | 'alliance',
  entityId: number,
): ShipProfile {
  const freq = new Map<number, { flown: number; kills_in: number; losses_in: number }>();
  const key = SCOPE_KEY[scope];

  for (const km of kills) {
    if (km.roles.attacker) {
      for (const atk of km.attackers) {
        if (atk[key] === entityId && atk.ship_type_id) {
          const entry = freq.get(atk.ship_type_id) ?? { flown: 0, kills_in: 0, losses_in: 0 };
          entry.flown++;
          entry.kills_in++;
          freq.set(atk.ship_type_id, entry);
        }
      }
    }
    if (km.roles.victim && km.ship_type_id) {
      const entry = freq.get(km.ship_type_id) ?? { flown: 0, kills_in: 0, losses_in: 0 };
      entry.flown++;
      entry.losses_in++;
      freq.set(km.ship_type_id, entry);
    }
  }

  const allTypeIds = new Set(freq.keys());
  const sdeMap = resolveShipNames(db, allTypeIds);

  let totalFlights = 0;
  const ships: ShipEntry[] = [];
  const hullClassCounts = new Map<string, number>();

  for (const [typeId, counts] of freq) {
    const sde = sdeMap.get(typeId) ?? { name: 'Unknown', group_name: 'Unknown' };
    ships.push({
      ship_type_id: typeId,
      ship_name: sde.name,
      hull_class: sde.group_name,
      times_flown: counts.flown,
      kills_in: counts.kills_in,
      losses_in: counts.losses_in,
    });
    totalFlights += counts.flown;
    hullClassCounts.set(sde.group_name, (hullClassCounts.get(sde.group_name) ?? 0) + counts.flown);
  }

  ships.sort((a, b) => b.times_flown - a.times_flown);

  const favoriteShip = ships.length > 0 ? ships[0].ship_name : null;

  let dominantHullClass: string | null = null;
  let maxClassCount = 0;
  for (const [cls, count] of hullClassCounts) {
    if (count > maxClassCount) {
      maxClassCount = count;
      dominantHullClass = cls;
    }
  }

  const capitalUsage = ships.some((s) => CAPITAL_GROUPS.has(s.hull_class));
  const shipDiversity = totalFlights > 0
    ? Math.min(1, Math.max(0, allTypeIds.size / totalFlights))
    : 0;

  return {
    ships,
    favorite_ship: favoriteShip,
    dominant_hull_class: dominantHullClass,
    ship_diversity: shipDiversity,
    capital_usage: capitalUsage,
    total_flights: totalFlights,
  };
}

export function analyzeFleetProfile(
  kills: OsintKillmail[],
  entityId?: number,
): FleetProfile {
  const killKms = kills.filter((km) => km.roles.attacker);
  const totalKills = killKms.length;

  if (totalKills === 0) {
    return {
      avg_fleet_size: 0,
      median_fleet_size: 0,
      solo_ratio: 0,
      small_gang_ratio: 0,
      medium_fleet_ratio: 0,
      large_fleet_ratio: 0,
      frequent_companions: [],
      total_kills_analyzed: 0,
    };
  }

  const attackerCounts = killKms.map((km) => km.attacker_count);

  const sum = attackerCounts.reduce((a, b) => a + b, 0);
  const avgFleetSize = sum / totalKills;

  const sorted = [...attackerCounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianFleetSize = sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;

  let soloCount = 0;
  let smallGangCount = 0;
  let mediumFleetCount = 0;
  let largeFleetCount = 0;

  for (const km of killKms) {
    if (km.is_solo) soloCount++;
    if (km.attacker_count >= 2 && km.attacker_count <= 10) smallGangCount++;
    if (km.attacker_count >= 11 && km.attacker_count <= 50) mediumFleetCount++;
    if (km.attacker_count > 50) largeFleetCount++;
  }

  const companionCounts = new Map<number, number>();
  for (const km of killKms) {
    for (const atk of km.attackers) {
      if (!atk.character_id || atk.character_id === entityId) continue;
      companionCounts.set(atk.character_id, (companionCounts.get(atk.character_id) ?? 0) + 1);
    }
  }

  const companions = [...companionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([charId, count]) => ({
      character_id: charId,
      character_name: `character:${charId}`,
      shared_kills: count,
    }));

  return {
    avg_fleet_size: avgFleetSize,
    median_fleet_size: medianFleetSize,
    solo_ratio: soloCount / totalKills,
    small_gang_ratio: smallGangCount / totalKills,
    medium_fleet_ratio: mediumFleetCount / totalKills,
    large_fleet_ratio: largeFleetCount / totalKills,
    frequent_companions: companions,
    total_kills_analyzed: totalKills,
  };
}
