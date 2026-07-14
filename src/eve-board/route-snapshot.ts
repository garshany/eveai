import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from '../eve/esi-client.js';
import {
  eveKillKillmailUrl,
  getKillmailDetail,
  searchKillmails,
} from '../eve-kill/client.js';
import type { NormalizedKillmail } from '../eve-kill/types.js';
import { attributeKillsToGates } from './analytics.js';
import type { GateKill, ThreatKillmail } from './types.js';

const SNAPSHOT_SCAN_WINDOW_MINUTES = 60;
const MAX_ENRICH_PER_SYSTEM = 3;
const MAX_SEARCH_RESULTS = 2_500;
const ENRICH_CONCURRENCY = 8;

type EsiKillmailVictim = {
  ship_type_id?: number;
  character_id?: number;
  corporation_id?: number;
  position?: { x?: number; y?: number; z?: number };
};

type EsiKillmailAttacker = {
  character_id?: number;
  corporation_id?: number;
  ship_type_id?: number;
  final_blow?: boolean;
};

type EsiKillmail = {
  killmail_time?: string;
  victim?: EsiKillmailVictim;
  attackers?: EsiKillmailAttacker[];
};

export type SnapshotKill = ThreatKillmail & {
  final_blow_ship_name?: string;
  eve_kill_url: string;
  time_msk: string | null;
};

export type RouteSnapshotSystem = {
  systemId: number;
  routeIndex: number;
  name: string;
  sec: number;
  pvpKills: number;
  npcKills: number;
  /** Value is based on the bounded detail sample, never presented as full coverage. */
  totalValueM: number;
  valueResolvedKills: number;
  recentKills: SnapshotKill[];
  gateKills: GateKill[];
};

export type RouteThreatSnapshot = {
  routeSystems: number[];
  systems: RouteSnapshotSystem[];
  jumpMap: Map<number, number>;
  totalKills: number;
  /** Sum from the bounded enriched detail sample. */
  totalValueM: number;
  truncated: boolean;
  requestCount: number;
  error: string | null;
  scannedAt: string;
};

/**
 * Build one source-neutral one-hour baseline for the supplied route systems.
 * The EVE-KILL search client owns 15-ID chunking and cursor pagination. ESI is
 * used only when an `(id, hash)` pair is available, and only its victim
 * position is trusted for gate attribution.
 */
export async function buildRouteThreatSnapshot(
  db: Db,
  routeSystems: number[],
): Promise<RouteThreatSnapshot> {
  const scannedAt = new Date().toISOString();
  const uniqueSystems = [...new Set(routeSystems.filter(validId))];
  const jumpMapPromise = fetchSystemJumps(db, uniqueSystems);
  if (uniqueSystems.length === 0) {
    return emptySnapshot(routeSystems, await jumpMapPromise, scannedAt, null);
  }

  const from = new Date(Date.parse(scannedAt) - SNAPSHOT_SCAN_WINDOW_MINUTES * 60_000).toISOString();
  const result = await searchKillmails(
    db,
    { from, to: scannedAt, system_ids: uniqueSystems },
    { limit: MAX_SEARCH_RESULTS },
  );
  const jumpMap = await jumpMapPromise;
  if (!result.ok) {
    return emptySnapshot(routeSystems, jumpMap, scannedAt, result.error);
  }

  const wanted = new Set(uniqueSystems);
  const pvpKills = result.data.kills.filter((kill) =>
    kill.solarSystemId !== undefined
    && wanted.has(kill.solarSystemId)
    && kill.isNpc !== true
    && isKillWithinWindow(kill.killmailTime, from, scannedAt),
  );
  const bySystem = groupKillsBySystem(pvpKills);
  const candidates = [...bySystem.values()].flatMap((kills) => kills.slice(0, MAX_ENRICH_PER_SYSTEM));
  const enriched = await mapWithConcurrency(
    candidates,
    ENRICH_CONCURRENCY,
    (kill) => enrichRouteKillmail(db, kill, { resolveNames: false }),
  );
  const officialNames = await resolveOfficialNames(
    db,
    enriched.flatMap((kill) => [kill.victim_character_id, kill.final_blow_character_id]),
  );
  for (const kill of enriched) {
    if (kill.victim_character_id) {
      kill.victim_character_name = officialNames.get(kill.victim_character_id);
    }
    if (kill.final_blow_character_id) {
      kill.final_blow_character_name = officialNames.get(kill.final_blow_character_id);
    }
  }
  const enrichedBySystem = new Map<number, SnapshotKill[]>();
  for (const kill of enriched) {
    const systemId = pvpKills.find((candidate) => candidate.killmailId === kill.killmail_id)?.solarSystemId;
    if (!systemId) continue;
    const current = enrichedBySystem.get(systemId) ?? [];
    current.push(kill);
    enrichedBySystem.set(systemId, current);
  }

  const systems: RouteSnapshotSystem[] = [];
  for (const systemId of uniqueSystems) {
    const kills = bySystem.get(systemId) ?? [];
    if (kills.length === 0) continue;
    const recentKills = (enrichedBySystem.get(systemId) ?? [])
      .sort((left, right) => (right.killmail_time ?? '').localeCompare(left.killmail_time ?? ''));
    const routeIndex = routeSystems.indexOf(systemId);
    const totalValueM = recentKills.reduce(
      (sum, kill) => sum + Math.round((kill.total_value ?? 0) / 1_000_000),
      0,
    );
    const gateKills = attributeKillsToGates(db, systemId, recentKills);
    systems.push({
      systemId,
      routeIndex,
      name: resolveSystemName(db, systemId),
      sec: resolveSystemSec(db, systemId),
      pvpKills: kills.length,
      npcKills: 0,
      totalValueM,
      valueResolvedKills: recentKills.filter((kill) => kill.total_value !== undefined).length,
      recentKills,
      gateKills,
    });
  }
  systems.sort((left, right) => left.routeIndex - right.routeIndex);

  return {
    routeSystems: [...routeSystems],
    systems,
    jumpMap,
    totalKills: pvpKills.length,
    totalValueM: systems.reduce((sum, system) => sum + system.totalValueM, 0),
    truncated: result.data.truncated,
    requestCount: result.data.requestCount,
    error: null,
    scannedAt,
  };
}

export async function enrichRouteKillmail(
  db: Db,
  base: NormalizedKillmail,
  options: { resolveNames?: boolean } = {},
): Promise<SnapshotKill> {
  const detailPromise = getKillmailDetail(db, base.killmailId);
  const officialPromise = base.killmailHash
    ? callEsiOperation<EsiKillmail>(
      db,
      'get_killmails_killmail_id_killmail_hash',
      { killmail_id: base.killmailId, killmail_hash: base.killmailHash },
    ).catch(() => null)
    : Promise.resolve(null);
  const [detailResult, officialResult] = await Promise.all([detailPromise, officialPromise]);
  const detail = detailResult.ok ? detailResult.data : undefined;
  const official = officialResult?.ok ? officialResult.data : undefined;
  const officialVictim = official?.victim;
  const officialAttackers = official?.attackers ?? [];
  const officialFinalBlow = officialAttackers.find((attacker) => attacker.final_blow === true)
    ?? officialAttackers[0];
  const baseFinalBlow = base.attackers.find((attacker) => attacker.finalBlow === true)
    ?? base.attackers[0];
  const detailFinalBlow = detail?.attackers.find((attacker) => attacker.finalBlow === true)
    ?? detail?.attackers[0];
  const victimShipTypeId = officialVictim?.ship_type_id
    ?? base.victim.shipTypeId
    ?? detail?.victim.shipTypeId;
  const finalBlowShipTypeId = officialFinalBlow?.ship_type_id
    ?? baseFinalBlow?.shipTypeId
    ?? detailFinalBlow?.shipTypeId;
  const victimType = resolveTypeGroup(db, victimShipTypeId);

  const enriched: SnapshotKill = {
    killmail_id: base.killmailId,
    killmail_time: official?.killmail_time ?? base.killmailTime ?? detail?.killmailTime,
    total_value: detail?.totalValue,
    attacker_count: officialAttackers.length || base.attackerCount || detail?.attackerCount || 0,
    is_npc: base.isNpc ?? detail?.isNpc,
    is_solo: base.isSolo ?? detail?.isSolo,
    ship_type_id: victimShipTypeId,
    ship_name: victimType?.typeName,
    ship_group_name: victimType?.groupName,
    victim_character_id: officialVictim?.character_id ?? base.victim.characterId ?? detail?.victim.characterId,
    final_blow_character_id: officialFinalBlow?.character_id
      ?? baseFinalBlow?.characterId
      ?? detailFinalBlow?.characterId,
    final_blow_ship_name: resolveTypeGroup(db, finalBlowShipTypeId)?.typeName,
    position: normalizePosition(officialVictim?.position),
    eve_kill_url: eveKillKillmailUrl(base.killmailId),
    time_msk: toMSK(official?.killmail_time ?? base.killmailTime ?? detail?.killmailTime),
  };
  if (options.resolveNames !== false) {
    const names = await resolveOfficialNames(
      db,
      [enriched.victim_character_id, enriched.final_blow_character_id],
    );
    if (enriched.victim_character_id) {
      enriched.victim_character_name = names.get(enriched.victim_character_id);
    }
    if (enriched.final_blow_character_id) {
      enriched.final_blow_character_name = names.get(enriched.final_blow_character_id);
    }
  }
  return enriched;
}

async function resolveOfficialNames(
  db: Db,
  rawIds: Array<number | undefined>,
): Promise<Map<number, string>> {
  const ids = [...new Set(rawIds.filter((id): id is number => id !== undefined && validId(id)))];
  const names = new Map<number, string>();
  for (let index = 0; index < ids.length; index += 1_000) {
    try {
      const result = await callEsiOperation<Array<{ id: number; name: string }>>(
        db,
        'post_universe_names',
        { ids: JSON.stringify(ids.slice(index, index + 1_000)) },
      );
      if (!result.ok) continue;
      for (const entry of result.data) {
        if (validId(entry.id) && typeof entry.name === 'string' && entry.name.length > 0) {
          names.set(entry.id, entry.name);
        }
      }
    } catch {
      // Identity labels are optional overlays; never substitute third-party names.
    }
  }
  return names;
}

function groupKillsBySystem(kills: NormalizedKillmail[]): Map<number, NormalizedKillmail[]> {
  const grouped = new Map<number, NormalizedKillmail[]>();
  for (const kill of kills) {
    if (!kill.solarSystemId) continue;
    const current = grouped.get(kill.solarSystemId) ?? [];
    current.push(kill);
    grouped.set(kill.solarSystemId, current);
  }
  for (const current of grouped.values()) {
    current.sort((left, right) => (right.killmailTime ?? '').localeCompare(left.killmailTime ?? ''));
  }
  return grouped;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < values.length) {
      const current = index;
      index += 1;
      result[current] = await mapper(values[current]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

type SystemJumpEntry = { system_id: number; ship_jumps: number };

async function fetchSystemJumps(db: Db, systemIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const wanted = new Set(systemIds);
  try {
    const result = await callEsiOperation<SystemJumpEntry[]>(db, 'get_universe_system_jumps', {});
    if (result.ok && Array.isArray(result.data)) {
      for (const entry of result.data) {
        if (wanted.has(entry.system_id) && entry.ship_jumps) map.set(entry.system_id, entry.ship_jumps);
      }
    }
  } catch {
    // Traffic is a non-critical overlay on the kill baseline.
  }
  return map;
}

const SEC_SQL =
  "coalesce(json_extract(data_json, '$.securityStatus'), json_extract(data_json, '$.security'))";

function resolveSystemName(db: Db, systemId: number): string {
  const row = db.prepare('SELECT name FROM sde_systems WHERE system_id = ?').get(systemId) as { name: string } | undefined;
  return row?.name ?? `System ${systemId}`;
}

function resolveSystemSec(db: Db, systemId: number): number {
  const row = db.prepare(`SELECT ${SEC_SQL} as sec FROM sde_systems WHERE system_id = ?`).get(systemId) as { sec: number | null } | undefined;
  if (typeof row?.sec !== 'number' || !Number.isFinite(row.sec)) return 0;
  return Math.round(row.sec * 10) / 10;
}

const typeGroupCaches = new WeakMap<Db, Map<number, { typeName: string; groupName: string } | null>>();

function resolveTypeGroup(
  db: Db,
  typeId: number | undefined,
): { typeName: string; groupName: string } | undefined {
  if (!typeId) return undefined;
  let cache = typeGroupCaches.get(db);
  if (!cache) {
    cache = new Map();
    typeGroupCaches.set(db, cache);
  }
  if (cache.has(typeId)) return cache.get(typeId) ?? undefined;
  const row = db.prepare(`
    SELECT t.name AS type_name, g.name AS group_name
    FROM sde_types AS t
    LEFT JOIN sde_groups AS g ON g.group_id = t.group_id
    WHERE t.type_id = ?
  `).get(typeId) as { type_name: string; group_name: string | null } | undefined;
  const value = row ? { typeName: row.type_name, groupName: row.group_name ?? '' } : null;
  cache.set(typeId, value);
  return value ?? undefined;
}

function normalizePosition(
  raw: EsiKillmailVictim['position'],
): { x: number; y: number; z: number } | undefined {
  if (!raw) return undefined;
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  const z = finiteNumber(raw.z);
  return x === undefined || y === undefined || z === undefined ? undefined : { x, y, z };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isKillWithinWindow(value: string | undefined, from: string, to: string): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(from) && time <= Date.parse(to);
}

function toMSK(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' MSK';
}

function emptySnapshot(
  routeSystems: number[],
  jumpMap: Map<number, number>,
  scannedAt: string,
  error: string | null,
): RouteThreatSnapshot {
  return {
    routeSystems: [...routeSystems],
    systems: [],
    jumpMap,
    totalKills: 0,
    totalValueM: 0,
    truncated: false,
    requestCount: 0,
    error,
    scannedAt,
  };
}
