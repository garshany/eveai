import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';
import type { KilllistItem } from '../eve-kill/client.js';
import { attributeKillsToGates } from './analytics.js';
import type { GateKill } from './types.js';

const SNAPSHOT_SCAN_WINDOW_MINUTES = 60;
const MAX_ENRICH_PER_SYSTEM = 3;

type ZkbItem = {
  killmail_id: number;
  zkb?: { hash?: string; totalValue?: number; npc?: boolean; solo?: boolean };
};

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

export type SnapshotKill = KilllistItem & {
  position?: { x: number; y: number; z: number };
  final_blow_ship_name?: string;
  zkb_url: string;
  zkb_time_msk: string | null;
};

export type RouteSnapshotSystem = {
  systemId: number;
  routeIndex: number;
  name: string;
  sec: number;
  pvpKills: number;
  npcKills: number;
  totalValueM: number;
  recentKills: SnapshotKill[];
  gateKills: GateKill[];
};

export type RouteThreatSnapshot = {
  routeSystems: number[];
  systems: RouteSnapshotSystem[];
  jumpMap: Map<number, number>;
  totalKills: number;
  totalValueM: number;
  scannedAt: string;
};

export async function buildRouteThreatSnapshot(
  db: Db,
  routeSystems: number[],
): Promise<RouteThreatSnapshot> {
  const candidates = routeSystems
    .map((systemId, routeIndex) => ({
      id: systemId,
      routeIndex,
      name: resolveSystemName(db, systemId),
      sec: resolveSystemSec(db, systemId),
    }));

  const systems: RouteSnapshotSystem[] = [];

  for (const system of candidates) {
    const feed = await fetchZkbForSnapshot(system.id);
    const pvpKills = feed.filter((kill) => !kill.zkb?.npc);
    if (pvpKills.length === 0) continue;

    const enrichedKills = await enrichSnapshotKills(db, pvpKills);
    const freshKills = enrichedKills
      .filter((kill) => isKillWithinWindow(kill.killmail_time))
      .sort((left, right) => (right.killmail_time ?? '').localeCompare(left.killmail_time ?? ''));
    if (freshKills.length === 0) continue;

    const totalValueM = freshKills.reduce(
      (sum, kill) => sum + Math.round((kill.total_value ?? 0) / 1_000_000),
      0,
    );
    const gateKills = attributeKillsToGates(
      db,
      system.id,
      freshKills.map((kill) => ({
        killmail_id: kill.killmail_id,
        killmail_time: kill.killmail_time,
        position: kill.position,
      })),
    );

    systems.push({
      systemId: system.id,
      routeIndex: system.routeIndex,
      name: system.name,
      sec: system.sec,
      pvpKills: freshKills.length,
      npcKills: 0,
      totalValueM,
      recentKills: freshKills,
      gateKills,
    });
  }

  systems.sort((left, right) => left.routeIndex - right.routeIndex);

  const jumpMap = await fetchSystemJumps(db, routeSystems);
  const totalKills = systems.reduce((sum, system) => sum + system.pvpKills, 0);
  const totalValueM = systems.reduce((sum, system) => sum + system.totalValueM, 0);

  return {
    routeSystems: [...routeSystems],
    systems,
    jumpMap,
    totalKills,
    totalValueM,
    scannedAt: new Date().toISOString(),
  };
}

async function fetchZkbForSnapshot(systemId: number): Promise<ZkbItem[]> {
  const url = `${config.zkill.baseUrl}kills/systemID/${systemId}/pastSeconds/3600/`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': config.zkill.userAgent },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((item: unknown): item is ZkbItem =>
      !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).killmail_id === 'number',
    );
  } catch {
    return [];
  }
}

async function enrichSnapshotKills(
  db: Db,
  items: ZkbItem[],
): Promise<SnapshotKill[]> {
  const pending: Array<{
    item: ZkbItem;
    km: EsiKillmail;
    victim: EsiKillmailVictim;
    attackers: EsiKillmailAttacker[];
    finalBlow: EsiKillmailAttacker | undefined;
  }> = [];
  const fallback: SnapshotKill[] = [];
  const idsToResolve = new Set<number>();

  for (const item of items.slice(0, MAX_ENRICH_PER_SYSTEM)) {
    const hash = item.zkb?.hash;
    if (!hash) {
      fallback.push(zkbFallback(item));
      continue;
    }

    try {
      const result = await callEsiOperation<EsiKillmail>(
        db,
        'get_killmails_killmail_id_killmail_hash',
        { killmail_id: item.killmail_id, killmail_hash: hash },
      );
      if (!result.ok || !result.data) {
        fallback.push(zkbFallback(item));
        continue;
      }

      const victim = result.data.victim ?? {};
      const attackers = result.data.attackers ?? [];
      const finalBlow = attackers.find((attacker) => attacker.final_blow === true) ?? attackers[0];
      pending.push({ item, km: result.data, victim, attackers, finalBlow });

      for (const id of [
        victim.character_id,
        victim.corporation_id,
        finalBlow?.character_id,
        finalBlow?.corporation_id,
      ]) {
        if (typeof id === 'number' && id > 0) idsToResolve.add(id);
      }
    } catch {
      fallback.push(zkbFallback(item));
    }
  }

  const nameMap = await resolveNamesBatch(db, idsToResolve);
  const kills = [...fallback];

  for (const entry of pending) {
    const victimShipId = normalizeOptionalInt(entry.victim.ship_type_id);
    const finalBlowShipId = normalizeOptionalInt(entry.finalBlow?.ship_type_id);

    kills.push({
      killmail_id: entry.item.killmail_id,
      killmail_time: typeof entry.km.killmail_time === 'string' ? entry.km.killmail_time : undefined,
      total_value: entry.item.zkb?.totalValue ?? 0,
      attacker_count: entry.attackers.length,
      is_npc: entry.item.zkb?.npc ?? false,
      is_solo: entry.item.zkb?.solo ?? false,
      ship_type_id: victimShipId ?? undefined,
      ship_name: resolveTypeName(db, victimShipId),
      victim_character_id: entry.victim.character_id,
      victim_character_name: resolveEntityName(nameMap, entry.victim.character_id, entry.victim.corporation_id),
      final_blow_character_id: entry.finalBlow?.character_id,
      final_blow_character_name: resolveEntityName(nameMap, entry.finalBlow?.character_id, entry.finalBlow?.corporation_id),
      final_blow_ship_name: resolveTypeName(db, finalBlowShipId),
      position: normalizePosition(entry.victim.position),
      zkb_url: `https://zkillboard.com/kill/${entry.item.killmail_id}/`,
      zkb_time_msk: entry.km.killmail_time ? toMSK(entry.km.killmail_time) : null,
    });
  }

  return kills;
}

async function resolveNamesBatch(db: Db, ids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.size === 0) return map;

  try {
    const result = await callEsiOperation<Array<{ id: number; name: string }>>(
      db,
      'post_universe_names',
      { ids: JSON.stringify([...ids].slice(0, 100)) },
    );
    if (result.ok && Array.isArray(result.data)) {
      for (const entry of result.data) {
        if (entry.id && entry.name) map.set(entry.id, entry.name);
      }
    }
  } catch {
    // Non-critical: details degrade gracefully without resolved names.
  }

  return map;
}

type SystemJumpEntry = { system_id: number; ship_jumps: number };

async function fetchSystemJumps(db: Db, systemIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const wanted = new Set(systemIds);

  try {
    const result = await callEsiOperation<SystemJumpEntry[]>(
      db,
      'get_universe_system_jumps',
      {},
    );
    if (result.ok && Array.isArray(result.data)) {
      for (const entry of result.data) {
        if (wanted.has(entry.system_id) && entry.ship_jumps) {
          map.set(entry.system_id, entry.ship_jumps);
        }
      }
    }
  } catch {
    // Non-critical.
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

const typeNameCache = new Map<number, string | null>();

function resolveTypeName(db: Db, typeId: number | null): string | undefined {
  if (typeId === null) return undefined;
  if (typeNameCache.has(typeId)) return typeNameCache.get(typeId) ?? undefined;

  const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  const name = row?.name ?? null;
  typeNameCache.set(typeId, name);
  return name ?? undefined;
}

function resolveEntityName(
  nameMap: Map<number, string>,
  primaryId: number | undefined,
  fallbackId: number | undefined,
): string | undefined {
  if (typeof primaryId === 'number' && primaryId > 0 && nameMap.has(primaryId)) return nameMap.get(primaryId);
  if (typeof fallbackId === 'number' && fallbackId > 0 && nameMap.has(fallbackId)) return nameMap.get(fallbackId);
  return undefined;
}

function zkbFallback(item: ZkbItem): SnapshotKill {
  return {
    killmail_id: item.killmail_id,
    total_value: item.zkb?.totalValue ?? 0,
    attacker_count: 1,
    is_npc: item.zkb?.npc ?? false,
    is_solo: item.zkb?.solo ?? false,
    zkb_url: `https://zkillboard.com/kill/${item.killmail_id}/`,
    zkb_time_msk: null,
  };
}

function normalizePosition(
  raw: EsiKillmailVictim['position'],
): { x: number; y: number; z: number } | undefined {
  if (!raw) return undefined;
  const x = normalizeOptionalNumber(raw.x);
  const y = normalizeOptionalNumber(raw.y);
  const z = normalizeOptionalNumber(raw.z);
  if (x === null || y === null || z === null) return undefined;
  return { x, y, z };
}

function normalizeOptionalInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toMSK(value: string): string {
  try {
    const date = new Date(value);
    return date.toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' MSK';
  } catch {
    return value;
  }
}

function isKillWithinWindow(value: string | undefined): boolean {
  const minutes = value ? minutesSinceIso(value) : null;
  return minutes === null || minutes <= SNAPSHOT_SCAN_WINDOW_MINUTES;
}

function minutesSinceIso(value: string): number | null {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60_000));
}
