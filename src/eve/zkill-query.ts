import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from './esi-client.js';

type ZkillFeedItem = {
  killmail_id: number;
  zkb?: {
    hash?: string;
    totalValue?: number;
    fittedValue?: number;
    points?: number;
    npc?: boolean;
    solo?: boolean;
    awox?: boolean;
  };
};

type CompactKill = {
  killmail_id: number;
  time: string | null;
  system: string | null;
  system_sec: number | null;
  victim_name: string | null;
  victim_corp: string | null;
  victim_ship: string | null;
  attacker_name: string | null;
  attacker_corp: string | null;
  attacker_ship: string | null;
  attacker_weapon: string | null;
  attackers_count: number;
  value_m: number | null;
  solo: boolean;
  npc: boolean;
  url: string;
};

export type ZkillQueryResult = {
  ok: boolean;
  path: string;
  feed_count: number;
  detailed: CompactKill[];
  error: string | null;
};

const MAX_FEED = 20;
const MAX_DETAIL = 10;

export async function executeZkillQuery(
  db: Db,
  path: string,
  detailLimit: number,
  chatId?: number | null,
): Promise<ZkillQueryResult> {
  const cleanPath = path.replace(/^\/+/, '').replace(/\/*$/, '/');
  const clampedDetail = Math.min(Math.max(detailLimit, 0), MAX_DETAIL);

  // Fetch zKill feed
  const baseUrl = config.zkill.baseUrl.endsWith('/') ? config.zkill.baseUrl : `${config.zkill.baseUrl}/`;
  const url = `${baseUrl}${cleanPath}`;

  let feed: ZkillFeedItem[];
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': config.zkill.userAgent,
      },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, path: cleanPath, feed_count: 0, detailed: [], error: `zKillboard HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      return { ok: false, path: cleanPath, feed_count: 0, detailed: [], error: 'zKillboard response is not an array' };
    }
    feed = data.filter((item: unknown): item is ZkillFeedItem =>
      !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).killmail_id === 'number'
    ).slice(0, MAX_FEED);
  } catch (err) {
    return { ok: false, path: cleanPath, feed_count: 0, detailed: [], error: (err as Error).message };
  }

  // Enrich top N with ESI killmail details
  const toEnrich = feed.slice(0, clampedDetail).filter((item) => item.zkb?.hash);
  const rawKills = await Promise.all(toEnrich.map((item) => fetchKillmailRaw(db, item)));
  const validRaw = rawKills.filter((k): k is RawKillData => k !== null);

  // Batch resolve all character/corporation IDs to names
  const idsToResolve = new Set<number>();
  for (const raw of validRaw) {
    for (const id of [raw.victimCharId, raw.victimCorpId, raw.attackerCharId, raw.attackerCorpId]) {
      if (id !== null) idsToResolve.add(id);
    }
  }
  const nameMap = await resolveNames(db, idsToResolve);

  const detailed: CompactKill[] = validRaw.map((raw) => ({
    killmail_id: raw.killmailId,
    time: raw.time,
    system: raw.system,
    system_sec: raw.systemSec,
    victim_name: nameMap.get(raw.victimCharId ?? 0) ?? null,
    victim_corp: nameMap.get(raw.victimCorpId ?? 0) ?? null,
    victim_ship: raw.victimShip,
    attacker_name: nameMap.get(raw.attackerCharId ?? 0) ?? null,
    attacker_corp: nameMap.get(raw.attackerCorpId ?? 0) ?? null,
    attacker_ship: raw.attackerShip,
    attacker_weapon: raw.attackerWeapon,
    attackers_count: raw.attackersCount,
    value_m: raw.valueM,
    solo: raw.solo,
    npc: raw.npc,
    url: `https://zkillboard.com/kill/${raw.killmailId}/`,
  }));

  return {
    ok: true,
    path: cleanPath,
    feed_count: feed.length,
    detailed,
    error: null,
  };
}

type RawKillData = {
  killmailId: number;
  time: string | null;
  system: string | null;
  systemSec: number | null;
  victimCharId: number | null;
  victimCorpId: number | null;
  victimShip: string | null;
  attackerCharId: number | null;
  attackerCorpId: number | null;
  attackerShip: string | null;
  attackerWeapon: string | null;
  attackersCount: number;
  valueM: number | null;
  solo: boolean;
  npc: boolean;
};

async function fetchKillmailRaw(db: Db, item: ZkillFeedItem): Promise<RawKillData | null> {
  const hash = item.zkb?.hash;
  if (!hash) return null;

  try {
    const result = await callEsiOperation<Record<string, unknown>>(
      db, 'get_killmails_killmail_id_killmail_hash',
      { killmail_id: item.killmail_id, killmail_hash: hash },
    );
    if (!result.ok || !result.data) return null;

    const km = result.data;
    const victim = asRec(km.victim);
    const attackers = Array.isArray(km.attackers) ? km.attackers as Record<string, unknown>[] : [];
    const finalBlow = attackers.find((a) => a.final_blow === true) ?? attackers[0] ?? {};

    const systemId = numField(km, 'solar_system_id');
    const systemInfo = systemId ? resolveSystemName(db, systemId) : null;

    return {
      killmailId: item.killmail_id,
      time: typeof km.killmail_time === 'string' ? km.killmail_time : null,
      system: systemInfo?.name ?? null,
      systemSec: systemInfo?.sec ?? null,
      victimCharId: numField(victim, 'character_id'),
      victimCorpId: numField(victim, 'corporation_id'),
      victimShip: resolveTypeName(db, numField(victim, 'ship_type_id')),
      attackerCharId: numField(finalBlow, 'character_id'),
      attackerCorpId: numField(finalBlow, 'corporation_id'),
      attackerShip: resolveTypeName(db, numField(finalBlow, 'ship_type_id')),
      attackerWeapon: resolveTypeName(db, numField(finalBlow, 'weapon_type_id')),
      attackersCount: attackers.length,
      valueM: item.zkb?.totalValue ? Math.round(item.zkb.totalValue / 1_000_000) : null,
      solo: item.zkb?.solo ?? false,
      npc: item.zkb?.npc ?? false,
    };
  } catch {
    return null;
  }
}

async function resolveNames(db: Db, ids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.size === 0) return map;

  const idArray = [...ids].slice(0, 100);
  try {
    const result = await callEsiOperation<Array<{ id: number; name: string }>>(
      db, 'post_universe_names', { ids: JSON.stringify(idArray) },
    );
    if (result.ok && Array.isArray(result.data)) {
      for (const entry of result.data) {
        if (entry.id && entry.name) map.set(entry.id, entry.name);
      }
    }
  } catch {
    // fallback — no names
  }
  return map;
}

// --- helpers ---

const typeNameCache = new Map<number, string | null>();

function resolveTypeName(db: Db, typeId: number | null): string | null {
  if (typeId === null) return null;
  if (typeNameCache.has(typeId)) return typeNameCache.get(typeId)!;
  const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  const name = row?.name ?? null;
  typeNameCache.set(typeId, name);
  return name;
}

function resolveSystemName(db: Db, systemId: number): { name: string; sec: number } | null {
  const row = db.prepare(
    "SELECT name, json_extract(data_json, '$.security') as sec FROM sde_systems WHERE system_id = ?"
  ).get(systemId) as { name: string; sec: number } | undefined;
  return row ? { name: row.name, sec: Math.round(row.sec * 10) / 10 } : null;
}

function asRec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strField(obj: Record<string, unknown>, key: string): string | null {
  return typeof obj[key] === 'string' && (obj[key] as string).trim() ? obj[key] as string : null;
}
