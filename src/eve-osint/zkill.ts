import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';

export type ZkillEntityScope = 'character' | 'corporation' | 'alliance';
export type ZkillActivityKind = 'kills' | 'losses';

type ZkbFeedItem = {
  killmail_id: number;
  zkb?: {
    hash?: string;
    totalValue?: number;
    npc?: boolean;
    solo?: boolean;
    awox?: boolean;
    labels?: string[];
  };
};

type EsiVictim = {
  character_id?: number;
  corporation_id?: number;
  alliance_id?: number;
  ship_type_id?: number;
};

type EsiAttacker = {
  character_id?: number;
  corporation_id?: number;
  alliance_id?: number;
  ship_type_id?: number;
  weapon_type_id?: number;
  final_blow?: boolean;
};

type PublicEsiKillmail = {
  solar_system_id?: number;
  killmail_time?: string;
  victim?: EsiVictim;
  attackers?: EsiAttacker[];
};

export type OsintKillmail = {
  activity: ZkillActivityKind;
  killmail_id: number;
  killmail_time?: string;
  solar_system_id?: number;
  total_value?: number;
  attacker_count: number;
  is_npc: boolean;
  is_solo: boolean;
  is_awox: boolean;
  ship_type_id?: number;
  victim_character_id?: number;
  victim_corporation_id?: number;
  victim_alliance_id?: number;
  final_blow_character_id?: number;
  final_blow_corporation_id?: number;
  final_blow_alliance_id?: number;
  attackers: EsiAttacker[];
  zkb_labels: string[];
  tz_label: string | null;
  location_label: string | null;
};

const MAX_FEED_PAGES = 10;
const MAX_ENRICHED_KILLS = 250;
const ESI_BATCH_SIZE = 25;

export async function fetchEntityActivityFeed(
  db: Db,
  args: {
    scope: ZkillEntityScope;
    id: number;
    activity: ZkillActivityKind;
    pastSeconds: number;
  },
): Promise<OsintKillmail[]> {
  const feedItems = await fetchEntityFeedPages(db, args);
  if (feedItems.length === 0) return [];

  const enriched: Array<OsintKillmail | null> = [];
  for (let i = 0; i < feedItems.length; i += ESI_BATCH_SIZE) {
    const batch = feedItems.slice(i, i + ESI_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((item) => enrichFeedItem(db, args.activity, item)));
    enriched.push(...batchResults);
  }

  return enriched
    .filter((entry): entry is OsintKillmail => entry !== null)
    .sort((a, b) => new Date((b?.killmail_time) ?? 0).getTime() - new Date((a?.killmail_time) ?? 0).getTime());
}

async function enrichFeedItem(
  db: Db,
  activity: ZkillActivityKind,
  item: ZkbFeedItem,
): Promise<OsintKillmail | null> {
  const hash = item.zkb?.hash;
  if (!hash) return null;

  const detail = await callEsiOperation<PublicEsiKillmail>(
    db,
    'get_killmails_killmail_id_killmail_hash',
    { killmail_id: item.killmail_id, killmail_hash: hash },
  );
  if (!detail.ok || !detail.data) return null;

  const victim = detail.data.victim ?? {};
  const attackers = Array.isArray(detail.data.attackers) ? detail.data.attackers : [];
  const finalBlow = attackers.find((entry) => entry.final_blow === true) ?? attackers[0];
  const labels = item.zkb?.labels?.filter((label): label is string => typeof label === 'string') ?? [];

  return {
    activity,
    killmail_id: item.killmail_id,
    killmail_time: detail.data.killmail_time,
    solar_system_id: detail.data.solar_system_id,
    total_value: item.zkb?.totalValue,
    attacker_count: attackers.length,
    is_npc: item.zkb?.npc === true,
    is_solo: item.zkb?.solo === true,
    is_awox: item.zkb?.awox === true,
    ship_type_id: victim.ship_type_id,
    victim_character_id: victim.character_id,
    victim_corporation_id: victim.corporation_id,
    victim_alliance_id: victim.alliance_id ?? undefined,
    final_blow_character_id: finalBlow?.character_id,
    final_blow_corporation_id: finalBlow?.corporation_id,
    final_blow_alliance_id: finalBlow?.alliance_id ?? undefined,
    attackers,
    zkb_labels: labels,
    tz_label: pickLabel(labels, 'tz:'),
    location_label: pickLabel(labels, 'loc:'),
  };
}

async function fetchEntityFeedPages(
  db: Db,
  args: {
    scope: ZkillEntityScope;
    id: number;
    activity: ZkillActivityKind;
    pastSeconds: number;
  },
): Promise<ZkbFeedItem[]> {
  const results: ZkbFeedItem[] = [];
  const seen = new Set<number>();

  for (let page = 1; page <= MAX_FEED_PAGES; page += 1) {
    const items = await fetchEntityFeedPage(db, args, page);
    if (items.length === 0) break;

    let newItems = 0;
    for (const item of items) {
      if (seen.has(item.killmail_id)) continue;
      seen.add(item.killmail_id);
      results.push(item);
      newItems += 1;
      if (results.length >= MAX_ENRICHED_KILLS) return results;
    }

    if (newItems === 0) break;
  }

  return results;
}

async function fetchEntityFeedPage(
  db: Db,
  args: {
    scope: ZkillEntityScope;
    id: number;
    activity: ZkillActivityKind;
    pastSeconds: number;
  },
  page: number,
): Promise<ZkbFeedItem[]> {
  const scopeKey = args.scope === 'character'
    ? 'characterID'
    : args.scope === 'corporation'
      ? 'corporationID'
      : 'allianceID';
  const pagePart = page > 1 ? `page/${page}/` : '';
  const pastPart = args.pastSeconds <= config.zkill.maxPastSeconds
    ? `pastSeconds/${args.pastSeconds}/`
    : '';
  const path = `${args.activity}/${scopeKey}/${args.id}/${pagePart}${pastPart}`;
  const cacheKey = `zkill:${path}`;
  const cached = readCache<ZkbFeedItem[]>(db, cacheKey);
  if (cached) return cached;

  const url = new URL(path, config.zkill.baseUrl.endsWith('/') ? config.zkill.baseUrl : `${config.zkill.baseUrl}/`);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': config.zkill.userAgent,
      },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    if (!Array.isArray(payload)) return [];
    const items = payload.filter((item: unknown): item is ZkbFeedItem =>
      !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).killmail_id === 'number',
    );
    writeCache(db, cacheKey, items, computeTtl(args.pastSeconds));
    return items;
  } catch {
    return [];
  }
}

function pickLabel(labels: string[], prefix: string): string | null {
  const match = labels.find((label) => label.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function computeTtl(pastSeconds: number): number {
  return Math.max(120, Math.min(config.zkill.cacheTtlSeconds, Math.floor(pastSeconds / 8)));
}

function readCache<T>(db: Db, key: string): T | null {
  const row = db.prepare(
    "SELECT response_text FROM esi_cache WHERE cache_key = ? AND expires_at > datetime('now')",
  ).get(key) as { response_text: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.response_text) as T;
  } catch {
    return null;
  }
}

function writeCache(db: Db, key: string, payload: unknown, ttlSeconds: number): void {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(cache_key) DO UPDATE SET
      response_text = excluded.response_text,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).run(key, JSON.stringify(payload), expiresAt);
}
