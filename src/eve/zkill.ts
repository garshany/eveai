import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation } from './esi-client.js';
import { getLinkedCharacter } from './sso.js';
import { enrichKillmailDetail, type KillmailDeps } from './killmail.js';
import { buildTypeLinkMeta } from './eve-links.js';

type ZkillToolName =
  | 'zkill_system_recent_kills'
  | 'zkill_entity_recent_activity'
  | 'zkill_ship_loss_fits';

type ZkillFeedItem = {
  killmail_id: number;
  zkb?: {
    hash?: string;
    locationID?: number;
    fittedValue?: number;
    droppedValue?: number;
    destroyedValue?: number;
    totalValue?: number;
    points?: number;
    npc?: boolean;
    solo?: boolean;
    awox?: boolean;
    labels?: string[];
  };
};

type MarketPrice = {
  average_price: number | null;
  adjusted_price: number | null;
};

const MAX_ZKILL_LIMIT = 20;
const MAX_DETAIL_LIMIT = 10;

export function isZkillToolName(name: string): name is ZkillToolName {
  return name === 'zkill_system_recent_kills'
    || name === 'zkill_entity_recent_activity'
    || name === 'zkill_ship_loss_fits';
}

export async function executeZkillTool(
  db: Db,
  name: ZkillToolName,
  args: Record<string, unknown>,
  chatId?: number | null,
): Promise<Record<string, unknown>> {
  if (name === 'zkill_system_recent_kills') {
    return await getSystemRecentKills(db, args, chatId ?? null);
  }
  if (name === 'zkill_entity_recent_activity') {
    return await getEntityRecentActivity(db, args, chatId ?? null);
  }
  return await getShipLossFits(db, args, chatId ?? null);
}

async function getSystemRecentKills(
  db: Db,
  args: Record<string, unknown>,
  chatId: number | null,
): Promise<Record<string, unknown>> {
  const systemId = normalizeInteger(args.system_id);
  if (systemId === null) {
    return { ok: false, error: 'system_id must be an integer.' };
  }
  const pastSeconds = normalizePastSeconds(args.past_seconds, 6 * 3600);
  const limit = normalizeInteger(args.limit, 5, 1, MAX_ZKILL_LIMIT) ?? 5;
  const detailLimit = normalizeInteger(args.detail_limit, Math.min(limit, 3), 0, Math.min(limit, MAX_DETAIL_LIMIT)) ?? 3;
  const filter = normalizeFeedFilter(args.filter, ['kills', 'losses', 'all']) ?? 'all';

  const feeds = await fetchFeeds(db, [
    ['kills', buildApiPath(['kills', 'systemID', String(systemId), 'pastSeconds', String(pastSeconds)])],
    ['losses', buildApiPath(['losses', 'systemID', String(systemId), 'pastSeconds', String(pastSeconds)])],
  ], filter);

  const selected = mergeFeedSections(feeds, limit);
  const detailed = await enrichFeedItems(db, selected.items.slice(0, detailLimit), chatId);
  const compacted = detailed.map(compactDetailedKillmail);

  return {
    ok: true,
    source: detailed.length > 0 ? 'zkillboard+esi' : 'zkillboard',
    query: {
      system_id: systemId,
      filter,
      past_seconds: pastSeconds,
      limit,
      detail_limit: detailLimit,
    },
    totals: selected.totals,
    summary: buildKillSummary(detailed),
    killmails: compacted,
    limitations: [
      'zKillboard — публичный внешний источник, а не официальный ESI.',
      'Подробности строятся только для первых killmail из выборки, чтобы не раздувать latency и трафик.',
      'Если подробный ESI killmail недоступен, запись остаётся только в кратком формате zKillboard.',
    ],
  };
}

async function getEntityRecentActivity(
  db: Db,
  args: Record<string, unknown>,
  chatId: number | null,
): Promise<Record<string, unknown>> {
  const entityKind = normalizeFeedFilter(args.entity_kind, ['character', 'corporation', 'alliance']);
  const entityId = normalizeInteger(args.entity_id);
  if (!entityKind || entityId === null) {
    return { ok: false, error: 'entity_kind must be character/corporation/alliance and entity_id must be an integer.' };
  }
  const activity = normalizeFeedFilter(args.activity, ['kills', 'losses', 'all']) ?? 'all';
  const pastSeconds = normalizePastSeconds(args.past_seconds, 24 * 3600);
  const limit = normalizeInteger(args.limit, 5, 1, MAX_ZKILL_LIMIT) ?? 5;
  const detailLimit = normalizeInteger(args.detail_limit, Math.min(limit, 4), 0, Math.min(limit, MAX_DETAIL_LIMIT)) ?? 4;
  const idKey = `${entityKind}ID`;

  const feeds = await fetchFeeds(db, [
    ['kills', buildApiPath(['kills', idKey, String(entityId), 'pastSeconds', String(pastSeconds)])],
    ['losses', buildApiPath(['losses', idKey, String(entityId), 'pastSeconds', String(pastSeconds)])],
  ], activity);

  const selected = mergeFeedSections(feeds, limit);
  const detailed = await enrichFeedItems(db, selected.items.slice(0, detailLimit), chatId);
  const compacted = detailed.map(compactDetailedKillmail);

  return {
    ok: true,
    source: detailed.length > 0 ? 'zkillboard+esi' : 'zkillboard',
    query: {
      entity_kind: entityKind,
      entity_id: entityId,
      activity,
      past_seconds: pastSeconds,
      limit,
      detail_limit: detailLimit,
    },
    totals: selected.totals,
    summary: buildKillSummary(detailed),
    killmails: compacted,
    limitations: [
      'zKillboard покрывает только killmail, которые попали в их ingestion pipeline; это не гарантированно полный мировой фид.',
      'Для entity activity лучше использовать это как public PvP signal, а не как абсолютную бухгалтерию аккаунта или корпорации.',
    ],
  };
}

async function getShipLossFits(
  db: Db,
  args: Record<string, unknown>,
  chatId: number | null,
): Promise<Record<string, unknown>> {
  const shipTypeId = normalizeInteger(args.ship_type_id);
  if (shipTypeId === null) {
    return { ok: false, error: 'ship_type_id must be an integer.' };
  }
  const pastSeconds = normalizePastSeconds(args.past_seconds, 7 * 24 * 3600);
  const limit = normalizeInteger(args.limit, 8, 1, MAX_ZKILL_LIMIT) ?? 8;
  const detailLimit = normalizeInteger(args.detail_limit, Math.min(limit, 8), 1, Math.min(limit, MAX_DETAIL_LIMIT)) ?? Math.min(limit, 8);

  const lossesFeed = await fetchZkillFeed(
    db,
    buildApiPath(['losses', 'shipTypeID', String(shipTypeId), 'pastSeconds', String(pastSeconds)]),
    pastSeconds,
  );
  if (!lossesFeed.ok) return lossesFeed;

  const killsFeed = await fetchZkillFeed(
    db,
    buildApiPath(['kills', 'shipTypeID', String(shipTypeId), 'pastSeconds', String(pastSeconds)]),
    pastSeconds,
  );

  const lossSelected = lossesFeed.items.slice(0, limit);
  const detailedLosses = await enrichFeedItems(db, lossSelected.slice(0, detailLimit), chatId);
  const matchingVictims = detailedLosses.filter((killmail) =>
    readNumber(asRecord(killmail.victim), 'ship_type_id') === shipTypeId
  );
  const killSelected = killsFeed.ok ? killsFeed.items.slice(0, limit) : [];
  const detailedKills = await enrichFeedItems(db, killSelected.slice(0, detailLimit), chatId);
  const matchingAttackers = detailedKills.filter((killmail) => killmailHasShipTypeAttacker(killmail, shipTypeId));
  const sampleShipName = readFieldString(asRecord(asRecord(matchingVictims[0]?.victim).ship), 'name');
    const shipLinks = sampleShipName ? buildTypeLinkMeta(shipTypeId, sampleShipName) : null;

  return {
    ok: true,
    source: matchingVictims.length > 0 ? 'zkillboard+esi' : 'zkillboard',
    query: {
      ship_type_id: shipTypeId,
      past_seconds: pastSeconds,
      limit,
      detail_limit: detailLimit,
    },
    total_matches: lossesFeed.items.length,
    total_kill_matches: killsFeed.ok ? killsFeed.items.length : 0,
    sample_ship_name: sampleShipName,
    ship_links: shipLinks,
    fit_meta: buildShipFitMeta(matchingVictims, matchingAttackers, shipTypeId, sampleShipName),
    top_fits: buildTopFitVariants(matchingVictims).slice(0, Math.min(limit, 5)),
    recent_losses: matchingVictims.slice(0, Math.min(3, matchingVictims.length)).map(compactKillmailForFitMeta),
    recent_kills: matchingAttackers.slice(0, Math.min(3, matchingAttackers.length)).map(compactAttackerKillmailForResearch),
    limitations: [
      'Это observed fit meta по недавним loss killmail, а не оптимизатор фитов.',
      'Полный fit атакующего корабля из ESI killmail обычно недоступен, поэтому fit-meta строится именно по потерям этого ship type.',
    ],
  };
}

async function fetchFeeds(
  db: Db,
  feeds: Array<[section: 'kills' | 'losses', path: string]>,
  filter: 'kills' | 'losses' | 'all',
): Promise<Array<{ section: 'kills' | 'losses'; items: ZkillFeedItem[] }>> {
  const selected = feeds.filter(([section]) => filter === 'all' || filter === section);
  const results = await Promise.all(selected.map(async ([section, path]) => {
    const result = await fetchZkillFeed(db, path, normalizePastSeconds(null, 3600));
    return {
      section,
      items: result.ok ? result.items : [],
    };
  }));
  return results;
}

async function fetchZkillFeed(
  db: Db,
  path: string,
  pastSeconds: number,
): Promise<{ ok: true; items: ZkillFeedItem[] } | { ok: false; error: string }> {
  const cacheKey = `zkill:${path}`;
  const cached = readCachedJson(db, cacheKey);
  if (cached && Array.isArray(cached)) {
    return { ok: true, items: cached.filter(isZkillFeedItem) };
  }

  const url = new URL(path.replace(/^\/+/, ''), normalizeBaseUrl(config.zkill.baseUrl));
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': config.zkill.userAgent,
      },
      signal: AbortSignal.timeout(config.zkill.timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, error: `zKillboard returned HTTP ${response.status}` };
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return { ok: false, error: 'zKillboard response is not an array.' };
    }
    const items = payload.filter(isZkillFeedItem);
    writeCachedJson(db, cacheKey, items, deriveCacheTtlSeconds(pastSeconds));
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: `zKillboard request failed: ${(err as Error).message}` };
  }
}

async function enrichFeedItems(
  db: Db,
  items: ZkillFeedItem[],
  chatId: number | null,
): Promise<Array<Record<string, unknown>>> {
  if (items.length === 0) return [];
  const deps = buildKillmailDeps(db);
  const linkedCharacterId = getLinkedCharacter(db, chatId ?? undefined)?.characterId ?? null;

  return await mapWithConcurrency(items, 4, async (item) => {
    const hash = item.zkb?.hash;
    if (!hash) {
      return compactZkillOnlyEntry(item);
    }

    const detail = await callEsiOperation<Record<string, unknown>>(db, 'get_killmails_killmail_id_killmail_hash', {
      killmail_id: item.killmail_id,
      killmail_hash: hash,
    });
    if (!detail.ok || !detail.data || typeof detail.data !== 'object' || Array.isArray(detail.data)) {
      return compactZkillOnlyEntry(item);
    }

    const enriched = await enrichKillmailDetail(db, detail.data, deps, { linkedCharacterId });
    return {
      ...compactZkillMeta(item),
      ...enriched,
    };
  });
}

function buildKillmailDeps(db: Db): KillmailDeps {
  let marketPricesPromise: Promise<Map<number, MarketPrice>> | null = null;

  return {
    fetchJson: async (_profile, command, args) => {
      const params = parseCliArgs(args);
      const operationName = mapLegacyKillmailCommand(command);
      if (!operationName) return null;
      const response = await callEsiOperation<Record<string, unknown> | Record<string, unknown>[]>(
        db,
        operationName,
        params,
      );
      return response.ok ? response.data as Record<string, unknown> | Record<string, unknown>[] : null;
    },
    getMarketPrices: async () => {
      if (!marketPricesPromise) {
        marketPricesPromise = loadMarketPrices(db);
      }
      return await marketPricesPromise;
    },
  };
}

async function loadMarketPrices(db: Db): Promise<Map<number, MarketPrice>> {
  const response = await callEsiOperation<Array<Record<string, unknown>>>(db, 'get_markets_prices', {});
  const prices = new Map<number, MarketPrice>();
  if (!response.ok || !Array.isArray(response.data)) {
    return prices;
  }
  for (const item of response.data) {
    const typeId = readNumber(item, 'type_id');
    if (typeId === null) continue;
    prices.set(typeId, {
      average_price: readNullableNumber(item, 'average_price'),
      adjusted_price: readNullableNumber(item, 'adjusted_price'),
    });
  }
  return prices;
}

function parseCliArgs(args: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const rawValue = args[index + 1];
    if (!key?.startsWith('--') || rawValue === undefined) continue;
    const value = Number(rawValue);
    parsed[key.slice(2)] = Number.isFinite(value) && rawValue.trim() !== '' ? value : rawValue;
  }
  return parsed;
}

function mapLegacyKillmailCommand(command: string): string | null {
  switch (command) {
    case 'characters_character_id':
      return 'get_characters_character_id';
    case 'corporations_corporation_id':
      return 'get_corporations_corporation_id';
    case 'alliances_alliance_id':
      return 'get_alliances_alliance_id';
    case 'killmails_killmail_id_killmail_hash':
      return 'get_killmails_killmail_id_killmail_hash';
    default:
      return null;
  }
}

function buildKillSummary(killmails: Array<Record<string, unknown>>): Record<string, unknown> {
  const topVictimShips = new Map<string, number>();
  const topSystems = new Map<string, number>();
  let totalValue = 0;
  let soloCount = 0;
  let npcOnlyCount = 0;
  let mostRecentKillmailTime: string | null = null;

  for (const killmail of killmails) {
    const victimShip = readFieldString(asRecord(asRecord(killmail.victim).ship), 'name');
    if (victimShip) topVictimShips.set(victimShip, (topVictimShips.get(victimShip) ?? 0) + 1);
    const systemName = readFieldString(asRecord(killmail.location), 'name');
    if (systemName) topSystems.set(systemName, (topSystems.get(systemName) ?? 0) + 1);
    totalValue += readNullableNumber(asRecord(killmail.summary), 'estimated_total_value') ?? 0;
    if (readBoolean(asRecord(killmail.summary), 'solo') === true) soloCount += 1;
    if (readBoolean(asRecord(killmail.summary), 'npc_only') === true) npcOnlyCount += 1;
    const time = readFieldString(killmail, 'killmail_time');
    if (time && (!mostRecentKillmailTime || time > mostRecentKillmailTime)) {
      mostRecentKillmailTime = time;
    }
  }

  return {
    killmail_count: killmails.length,
    most_recent_killmail_time: mostRecentKillmailTime,
    total_estimated_value: totalValue > 0 ? Number(totalValue.toFixed(2)) : null,
    solo_kills: soloCount,
    npc_only_kills: npcOnlyCount,
    top_victim_ships: sortTopCounts(topVictimShips, 5),
    top_systems: sortTopCounts(topSystems, 5),
  };
}

function buildShipFitMeta(
  killmails: Array<Record<string, unknown>>,
  attackerKillmails: Array<Record<string, unknown>>,
  shipTypeId: number,
  shipName: string | null,
): Record<string, unknown> {
  const slotCounters = {
    high_slots: new Map<string, number>(),
    mid_slots: new Map<string, number>(),
    low_slots: new Map<string, number>(),
    rig_slots: new Map<string, number>(),
    subsystem_slots: new Map<string, number>(),
    drone_bay: new Map<string, number>(),
    fighter_bay: new Map<string, number>(),
    implants: new Map<string, number>(),
  };
  const systemCounts = new Map<string, number>();
  const threatShipCounts = new Map<string, number>();
  const targetShipCounts = new Map<string, number>();
  const values: number[] = [];
  let mostRecentKillmailTime: string | null = null;
  const roleCounters = new Map<string, number>();

  for (const killmail of killmails) {
    const victim = asRecord(killmail.victim);
    const fit = asRecord(victim.fit);
    const systemName = readFieldString(asRecord(killmail.location), 'name');
    if (systemName) systemCounts.set(systemName, (systemCounts.get(systemName) ?? 0) + 1);
    const value = readNullableNumber(asRecord(victim.pricing), 'estimated_total_value');
    if (value !== null) values.push(value);
    const time = readFieldString(killmail, 'killmail_time');
    if (time && (!mostRecentKillmailTime || time > mostRecentKillmailTime)) {
      mostRecentKillmailTime = time;
    }

    for (const [slot, counter] of Object.entries(slotCounters)) {
      const items = Array.isArray(fit[slot]) ? fit[slot] as Array<Record<string, unknown>> : [];
      const uniqueNames = new Set<string>();
      for (const item of items) {
        const typeName = readFieldString(item, 'type_name');
        if (typeName) uniqueNames.add(typeName);
      }
      for (const name of uniqueNames) {
        counter.set(name, (counter.get(name) ?? 0) + 1);
      }
    }

    const role = inferFitRole(fit);
    roleCounters.set(role, (roleCounters.get(role) ?? 0) + 1);
    for (const attacker of asRecordArray(killmail.attackers)) {
      const attackerShip = readFieldString(asRecord(attacker.ship), 'name');
      if (attackerShip) threatShipCounts.set(attackerShip, (threatShipCounts.get(attackerShip) ?? 0) + 1);
    }
  }

  for (const killmail of attackerKillmails) {
    const victimShip = readFieldString(asRecord(asRecord(killmail.victim).ship), 'name');
    if (victimShip) targetShipCounts.set(victimShip, (targetShipCounts.get(victimShip) ?? 0) + 1);
  }

  const averageLossValue = values.length > 0
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
    : null;

  const likelyRole = sortTopCounts(roleCounters, 3).map((entry) => entry.name);
  const shipLinks = shipName ? buildTypeLinkMeta(shipTypeId, shipName) : null;

  return {
    ship_name: shipName,
    ship_links: shipLinks,
    sample_size: killmails.length,
    offensive_sample_size: attackerKillmails.length,
    most_recent_killmail_time: mostRecentKillmailTime,
    average_estimated_loss_value: averageLossValue,
    likely_roles: likelyRole,
    top_systems: sortTopCounts(systemCounts, 5),
    common_threats: sortTopCounts(threatShipCounts, 5),
    common_targets: sortTopCounts(targetShipCounts, 5),
    top_modules_by_slot: Object.fromEntries(
      Object.entries(slotCounters).map(([slot, counter]) => [slot, sortTopCounts(counter, 5)])
    ),
  };
}

function buildTopFitVariants(killmails: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const variants = new Map<string, {
    count: number;
    role: string;
    signature_modules: string[];
    sample_killmail: Record<string, unknown>;
    systems: Map<string, number>;
    target_ships: Map<string, number>;
    threat_ships: Map<string, number>;
  }>();

  for (const killmail of killmails) {
    const victim = asRecord(killmail.victim);
    const fit = asRecord(victim.fit);
    const signature = buildFitSignature(fit);
    const role = inferFitRole(fit);
    const systemName = readFieldString(asRecord(killmail.location), 'name');
    const targetShip = readFieldString(asRecord(victim.ship), 'name');
    const threatShip = readFieldString(asRecord(asRecordArray(killmail.attackers)[0]?.ship), 'name');
    const existing = variants.get(signature) ?? {
      count: 0,
      role,
      signature_modules: extractSignatureModules(fit),
      sample_killmail: compactKillmailForFitMeta(killmail),
      systems: new Map<string, number>(),
      target_ships: new Map<string, number>(),
      threat_ships: new Map<string, number>(),
    };

    existing.count += 1;
    if (systemName) existing.systems.set(systemName, (existing.systems.get(systemName) ?? 0) + 1);
    if (targetShip) existing.target_ships.set(targetShip, (existing.target_ships.get(targetShip) ?? 0) + 1);
    if (threatShip) existing.threat_ships.set(threatShip, (existing.threat_ships.get(threatShip) ?? 0) + 1);
    variants.set(signature, existing);
  }

  return [...variants.values()]
    .sort((left, right) => right.count - left.count)
    .map((variant) => ({
      count: variant.count,
      role: variant.role,
      signature_modules: variant.signature_modules,
      common_systems: sortTopCounts(variant.systems, 3),
      common_targets: sortTopCounts(variant.target_ships, 3),
      common_threats: sortTopCounts(variant.threat_ships, 3),
      sample: variant.sample_killmail,
    }));
}

function compactKillmailForFitMeta(killmail: Record<string, unknown>): Record<string, unknown> {
  const victim = asRecord(killmail.victim);
  const fit = asRecord(victim.fit);
  const ship = asRecord(victim.ship);
  return {
    killmail_id: readNumber(killmail, 'killmail_id'),
    killmail_time: readFieldString(killmail, 'killmail_time'),
    system: readFieldString(asRecord(killmail.location), 'name'),
    victim: readFieldString(victim, 'character_name') ?? readFieldString(asRecord(victim.corporation), 'name') ?? null,
    ship: readFieldString(ship, 'name'),
    ship_commands: asRecord(ship.telegram_commands),
    estimated_total_value: readNullableNumber(asRecord(victim.pricing), 'estimated_total_value'),
    fit: {
      high_slots: compactFitBucket(fit.high_slots),
      mid_slots: compactFitBucket(fit.mid_slots),
      low_slots: compactFitBucket(fit.low_slots),
      rig_slots: compactFitBucket(fit.rig_slots),
      drone_bay: compactFitBucket(fit.drone_bay),
      implants: compactFitBucket(fit.implants),
    },
  };
}

function compactAttackerKillmailForResearch(killmail: Record<string, unknown>): Record<string, unknown> {
  const victim = asRecord(killmail.victim);
  const attacker = findRelevantAttacker(killmail);
  return {
    killmail_id: readNumber(killmail, 'killmail_id'),
    killmail_time: readFieldString(killmail, 'killmail_time'),
    system: readFieldString(asRecord(killmail.location), 'name'),
    victim: readFieldString(victim, 'character_name') ?? readFieldString(asRecord(victim.corporation), 'name') ?? null,
    victim_ship: readFieldString(asRecord(victim.ship), 'name'),
    attacker: attacker
      ? readFieldString(attacker, 'character_name') ?? readFieldString(asRecord(attacker.corporation), 'name')
      : null,
    attacker_ship: attacker ? readFieldString(asRecord(attacker.ship), 'name') : null,
    weapon: attacker ? readFieldString(asRecord(attacker.weapon), 'name') : null,
    final_blow: attacker ? readBoolean(attacker, 'final_blow') : null,
    estimated_total_value: readNullableNumber(asRecord(victim.pricing), 'estimated_total_value'),
  };
}

function compactDetailedKillmail(killmail: Record<string, unknown>): Record<string, unknown> {
  const victim = asRecord(killmail.victim);
  const finalBlow = findRelevantAttacker(killmail);
  const victimShip = asRecord(victim.ship);
  const finalBlowShip = asRecord(asRecord(finalBlow).ship);
  const finalBlowWeapon = asRecord(asRecord(finalBlow).weapon);

  return {
    killmail_id: readNumber(killmail, 'killmail_id'),
    killmail_time: readFieldString(killmail, 'killmail_time'),
    system: readFieldString(asRecord(killmail.location), 'name'),
    security_band: readFieldString(asRecord(killmail.location), 'security_band'),
    attackers_count: readNumber(asRecord(killmail.summary), 'attackers_count'),
    estimated_total_value: readNullableNumber(asRecord(killmail.summary), 'estimated_total_value'),
    solo: readBoolean(asRecord(killmail.summary), 'solo'),
    victim: {
      name: readFieldString(victim, 'character_name') ?? readFieldString(victim, 'corporation_name'),
      ship: readFieldString(victimShip, 'name'),
      ship_links: asRecord(victimShip.links),
      ship_commands: asRecord(victimShip.telegram_commands),
      victim_commands: asRecord(victim.telegram_commands),
    },
    final_blow: finalBlow
      ? {
          name: readFieldString(finalBlow, 'character_name') ?? readFieldString(finalBlow, 'corporation_name'),
          ship: readFieldString(finalBlowShip, 'name'),
          weapon: readFieldString(finalBlowWeapon, 'name'),
          ship_links: asRecord(finalBlowShip.links),
          ship_commands: asRecord(finalBlowShip.telegram_commands),
          attacker_commands: asRecord(finalBlow.telegram_commands),
        }
      : null,
    top_damage_by: readFieldString(asRecord(killmail.summary), 'top_damage_by'),
  };
}

function compactFitBucket(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readFieldString(asRecord(item), 'type_name'))
    .filter((entry): entry is string => !!entry)
    .slice(0, 4);
}

function compactZkillOnlyEntry(item: ZkillFeedItem): Record<string, unknown> {
  return {
    killmail_id: item.killmail_id,
    zkb: compactZkillMeta(item).zkb,
    source: 'zkillboard',
    limitation: 'Detailed ESI killmail could not be fetched for this entry.',
  };
}

function compactZkillMeta(item: ZkillFeedItem): Record<string, unknown> {
  return {
    killmail_id: item.killmail_id,
    zkb: {
      hash: item.zkb?.hash ?? null,
      location_id: item.zkb?.locationID ?? null,
      total_value: item.zkb?.totalValue ?? null,
      fitted_value: item.zkb?.fittedValue ?? null,
      dropped_value: item.zkb?.droppedValue ?? null,
      destroyed_value: item.zkb?.destroyedValue ?? null,
      points: item.zkb?.points ?? null,
      npc: item.zkb?.npc ?? null,
      solo: item.zkb?.solo ?? null,
      awox: item.zkb?.awox ?? null,
      labels: Array.isArray(item.zkb?.labels) ? item.zkb?.labels : [],
    },
  };
}

function mergeFeedSections(
  feeds: Array<{ section: 'kills' | 'losses'; items: ZkillFeedItem[] }>,
  limit: number,
): { items: ZkillFeedItem[]; totals: Record<string, unknown> } {
  const tagged = feeds.flatMap(({ section, items }) => items.map((item) => ({ section, item })));
  const limited = tagged.slice(0, limit);
  return {
    items: limited.map((entry) => entry.item),
    totals: {
      kills: feeds.find((entry) => entry.section === 'kills')?.items.length ?? 0,
      losses: feeds.find((entry) => entry.section === 'losses')?.items.length ?? 0,
      selected: limited.length,
    },
  };
}

function buildApiPath(segments: string[]): string {
  return `${segments.map((segment) => encodeURIComponent(segment)).join('/')}/`;
}

function normalizePastSeconds(value: unknown, fallback: number): number {
  const parsed = normalizeInteger(value, fallback, 3600, config.zkill.maxPastSeconds) ?? fallback;
  return Math.max(3600, Math.floor(parsed / 3600) * 3600);
}

function normalizeInteger(
  value: unknown,
  fallback?: number,
  min?: number,
  max?: number,
): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback ?? null;
  }
  const rounded = Math.trunc(parsed);
  const minApplied = min !== undefined ? Math.max(rounded, min) : rounded;
  return max !== undefined ? Math.min(minApplied, max) : minApplied;
}

function normalizeFeedFilter<T extends string>(value: unknown, allowed: T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
}

function deriveCacheTtlSeconds(pastSeconds: number): number {
  return Math.max(60, Math.min(config.zkill.cacheTtlSeconds, Math.floor(pastSeconds / 4)));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function readCachedJson(db: Db, cacheKey: string): unknown | null {
  const row = db.prepare(
    'SELECT response_text FROM esi_cache WHERE cache_key = ? AND expires_at > datetime(\'now\')'
  ).get(cacheKey) as { response_text: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.response_text) as unknown;
  } catch {
    return null;
  }
}

function writeCachedJson(db: Db, cacheKey: string, payload: unknown, ttlSeconds: number): void {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO esi_cache (cache_key, response_text, expires_at, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(cache_key) DO UPDATE SET
      response_text = excluded.response_text,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).run(cacheKey, JSON.stringify(payload), expiresAt);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) break;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
  return results;
}

function sortTopCounts(counter: Map<string, number>, limit: number): Array<{ name: string; count: number }> {
  return [...counter.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function buildFitSignature(fit: Record<string, unknown>): string {
  const buckets = [
    compactFitBucket(fit.high_slots),
    compactFitBucket(fit.mid_slots),
    compactFitBucket(fit.low_slots),
    compactFitBucket(fit.rig_slots),
    compactFitBucket(fit.drone_bay),
  ];
  return buckets.map((bucket) => [...bucket].sort().join('|')).join('::');
}

function extractSignatureModules(fit: Record<string, unknown>): string[] {
  return [
    ...compactFitBucket(fit.high_slots),
    ...compactFitBucket(fit.mid_slots),
    ...compactFitBucket(fit.low_slots),
    ...compactFitBucket(fit.rig_slots),
  ].slice(0, 8);
}

function inferFitRole(fit: Record<string, unknown>): string {
  const highs = compactFitBucket(fit.high_slots).join(' ').toLowerCase();
  const mids = compactFitBucket(fit.mid_slots).join(' ').toLowerCase();
  const lows = compactFitBucket(fit.low_slots).join(' ').toLowerCase();
  const drones = compactFitBucket(fit.drone_bay).join(' ').toLowerCase();

  if (highs.includes('probe') || highs.includes('core probe')) return 'probe / roam';
  if (mids.includes('afterburner') && mids.includes('shield extender')) return 'shield brawl / roam';
  if (mids.includes('microwarpdrive') || mids.includes('warp disruptor') || mids.includes('warp scrambler')) return 'kite / tackle';
  if (lows.includes('drone damage amplifier') || drones.includes('vespa') || drones.includes('hammerhead')) return 'drone damage platform';
  if (mids.includes('shield booster') || mids.includes('large shield booster')) return 'active tank';
  return 'general combat / mixed utility';
}

function killmailHasShipTypeAttacker(killmail: Record<string, unknown>, shipTypeId: number): boolean {
  return asRecordArray(killmail.attackers).some((attacker) => readNumber(attacker, 'ship_type_id') === shipTypeId);
}

function findRelevantAttacker(killmail: Record<string, unknown>): Record<string, unknown> | null {
  const attackers = asRecordArray(killmail.attackers);
  return attackers.find((attacker) => readBoolean(attacker, 'final_blow') === true) ?? attackers[0] ?? null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>);
}

function isZkillFeedItem(value: unknown): value is ZkillFeedItem {
  const record = asRecord(value);
  return readNumber(record, 'killmail_id') !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readFieldString(record: Record<string, unknown>, key: string): string | null {
  return readString(record[key]);
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  return typeof record[key] === 'boolean' ? record[key] as boolean : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
