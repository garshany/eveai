import type { Db } from '../db/sqlite.js';
import { buildInformationAction, buildMarketDetailsAction, buildTypeLinkMeta } from './eve-links.js';

const MAX_REF_EXPANSION = 10;

type JsonValue = Record<string, unknown> | unknown[];

type CharacterPublicInfo = {
  character_id: number;
  name: string | null;
  corporation_id: number | null;
  alliance_id: number | null;
  security_status: number | null;
};

type CorporationPublicInfo = {
  corporation_id: number;
  name: string | null;
  ticker: string | null;
};

type AlliancePublicInfo = {
  alliance_id: number;
  name: string | null;
  ticker: string | null;
};

type FactionInfo = {
  faction_id: number;
  name: string | null;
};

type SystemInfo = {
  system_id: number;
  name: string | null;
  security: number | null;
  security_band: string | null;
  constellation: { id: number; name: string | null } | null;
  region: { id: number; name: string | null } | null;
};

type TypeInfo = {
  type_id: number;
  name: string | null;
  group: { id: number | null; name: string | null } | null;
  category: { id: number | null; name: string | null } | null;
  market_group_id: number | null;
  base_price: number | null;
};

type FlagInfo = {
  flag: number;
  name: string | null;
  slot_group: string;
};

type MarketPrice = {
  average_price: number | null;
  adjusted_price: number | null;
};

export interface KillmailDeps {
  fetchJson: (
    profile: string,
    command: string,
    args: string[],
    options?: { maxOutputBytes?: number },
  ) => Promise<JsonValue | null>;
  getMarketPrices: () => Promise<Map<number, MarketPrice>>;
}

export async function enrichKillmailOcliOutput(
  db: Db,
  command: string,
  output: string,
  deps: KillmailDeps,
  options?: { linkedCharacterId?: number | null },
): Promise<string | null> {
  const parsed = tryParseJson(output);
  if (!parsed) return null;

  if (isRecord(parsed) && command === 'killmails_killmail_id_killmail_hash') {
    const enriched = await enrichKillmailDetail(db, parsed, deps, options);
    return JSON.stringify(enriched, null, 2);
  }

  if (Array.isArray(parsed) && parsed.every(isKillmailRef)) {
    const enriched = await enrichKillmailReferenceList(db, parsed, deps, options);
    return JSON.stringify(enriched, null, 2);
  }

  return null;
}

export async function enrichKillmailReferenceList(
  db: Db,
  refs: Array<Record<string, unknown>>,
  deps: KillmailDeps,
  options?: { linkedCharacterId?: number | null },
): Promise<Record<string, unknown>> {
  const expandedRefs = refs.slice(0, MAX_REF_EXPANSION);
  const remainingRefs = refs.slice(MAX_REF_EXPANSION);
  const expandedKillmails = await mapWithConcurrency(expandedRefs, 4, async (ref) => {
    const killmailId = readNumeric(ref, 'killmail_id');
    const killmailHash = readString(ref, 'killmail_hash');
    if (killmailId === null || !killmailHash) {
      return null;
    }

    const detailed = await deps.fetchJson(
      'eve-public',
      'killmails_killmail_id_killmail_hash',
      ['--killmail_id', String(killmailId), '--killmail_hash', killmailHash],
      { maxOutputBytes: 512 * 1024 },
    );
    if (!isRecord(detailed)) {
      return {
        killmail_id: killmailId,
        killmail_hash: killmailHash,
        error: 'Не удалось получить подробный killmail из ESI.',
      };
    }

    return await enrichKillmailDetail(db, detailed, deps, options);
  });

  return {
    kind: 'killmail_reference_list',
    source: 'esi',
    total_refs: refs.length,
    expanded_count: expandedKillmails.length,
    linked_character_id: options?.linkedCharacterId ?? null,
    limitations: [
      'ESI не даёт публичную глобальную ленту киллов по системе как zKillboard. Здесь обогащаются только killmail-ссылки, которые уже пришли из ESI.',
      'Подробно раскрыты первые killmail из списка. Остальные refs сохранены отдельно.',
    ],
    killmails: expandedKillmails,
    remaining_refs: remainingRefs,
  };
}

export async function enrichKillmailDetail(
  db: Db,
  killmail: Record<string, unknown>,
  deps: KillmailDeps,
  options?: { linkedCharacterId?: number | null },
): Promise<Record<string, unknown>> {
  const attackers = asRecordArray(killmail.attackers);
  const victim = asRecord(killmail.victim);
  const prices = await deps.getMarketPrices();

  const characterIds = new Set<number>();
  const corporationIds = new Set<number>();
  const allianceIds = new Set<number>();
  const factionIds = new Set<number>();

  collectEntityIds(victim, characterIds, corporationIds, allianceIds, factionIds);
  for (const attacker of attackers) {
    collectEntityIds(attacker, characterIds, corporationIds, allianceIds, factionIds);
  }

  const characters = new Map<number, CharacterPublicInfo | null>();
  const corporations = new Map<number, CorporationPublicInfo | null>();
  const alliances = new Map<number, AlliancePublicInfo | null>();
  const factions = new Map<number, FactionInfo | null>();

  const characterResults = await mapWithConcurrency(Array.from(characterIds.values()), 6, async (characterId) => {
    const data = await deps.fetchJson('eve-public', 'characters_character_id', ['--character_id', String(characterId)]);
    return [characterId, normalizeCharacterInfo(characterId, data)] as const;
  });
  for (const [characterId, info] of characterResults) {
    characters.set(characterId, info);
    if (info?.corporation_id) corporationIds.add(info.corporation_id);
    if (info?.alliance_id) allianceIds.add(info.alliance_id);
  }

  const corporationResults = await mapWithConcurrency(Array.from(corporationIds.values()), 6, async (corporationId) => {
    const data = await deps.fetchJson('eve-public', 'corporations_corporation_id', ['--corporation_id', String(corporationId)]);
    return [corporationId, normalizeCorporationInfo(corporationId, data)] as const;
  });
  for (const [corporationId, info] of corporationResults) {
    corporations.set(corporationId, info);
  }

  const allianceResults = await mapWithConcurrency(Array.from(allianceIds.values()), 6, async (allianceId) => {
    const data = await deps.fetchJson('eve-public', 'alliances_alliance_id', ['--alliance_id', String(allianceId)]);
    return [allianceId, normalizeAllianceInfo(allianceId, data)] as const;
  });
  for (const [allianceId, info] of allianceResults) {
    alliances.set(allianceId, info);
  }

  for (const factionId of factionIds) {
    factions.set(factionId, resolveFactionInfo(db, factionId));
  }

  const system = resolveSystemInfo(db, readNumeric(killmail, 'solar_system_id'));
  const enrichedAttackers = attackers.map((attacker) =>
    enrichParticipant(db, attacker, characters, corporations, alliances, factions, prices)
  );
  const enrichedVictim = enrichVictim(db, victim, characters, corporations, alliances, factions, prices);

  const finalBlowAttacker = enrichedAttackers.find((attacker) => readBoolean(attacker, 'final_blow') === true) ?? null;
  const topDamageAttacker = [...enrichedAttackers]
    .sort((left, right) => (readNumeric(right, 'damage_done') ?? 0) - (readNumeric(left, 'damage_done') ?? 0))[0] ?? null;

  const linkedCharacterRole = deriveLinkedCharacterRole(
    options?.linkedCharacterId ?? null,
    enrichedVictim,
    enrichedAttackers,
  );

  const victimPricing = asRecord(enrichedVictim.pricing);
  const summary = {
    attackers_count: enrichedAttackers.length,
    final_blow_by: finalBlowAttacker ? participantLabel(finalBlowAttacker) : null,
    top_damage_by: topDamageAttacker ? participantLabel(topDamageAttacker) : null,
    victim: participantLabel(enrichedVictim),
    victim_ship: readString(asRecord(enrichedVictim.ship), 'name'),
    system: system?.name ?? null,
    security_band: system?.security_band ?? null,
    estimated_total_value: readNumeric(victimPricing, 'estimated_total_value'),
    estimated_destroyed_value: readNumeric(victimPricing, 'estimated_destroyed_value'),
    estimated_dropped_value: readNumeric(victimPricing, 'estimated_dropped_value'),
    estimated_value_method: 'esi markets_prices with sde basePrice fallback',
    solo: enrichedAttackers.length === 1,
    npc_only: enrichedAttackers.every((attacker) => readNumeric(attacker, 'character_id') === null),
  };

  return {
    ...killmail,
    source: 'esi',
    limitations: [
      'ESI killmail даёт полный фит и содержимое жертвы, но не полный фит атакующих.',
      'Стоимость здесь рассчитана по ESI markets_prices с fallback на SDE basePrice. Это оценка, а не zKillboard total value.',
      'Публичная статистика эффективности персонажей и корпораций в стиле zKillboard через ESI недоступна.',
    ],
    location: system,
    linked_character_role: linkedCharacterRole,
    summary,
    victim: enrichedVictim,
    attackers: enrichedAttackers,
  };
}

function collectEntityIds(
  participant: Record<string, unknown>,
  characterIds: Set<number>,
  corporationIds: Set<number>,
  allianceIds: Set<number>,
  factionIds: Set<number>,
): void {
  const characterId = readNumeric(participant, 'character_id');
  const corporationId = readNumeric(participant, 'corporation_id');
  const allianceId = readNumeric(participant, 'alliance_id');
  const factionId = readNumeric(participant, 'faction_id');
  if (characterId !== null) characterIds.add(characterId);
  if (corporationId !== null) corporationIds.add(corporationId);
  if (allianceId !== null) allianceIds.add(allianceId);
  if (factionId !== null) factionIds.add(factionId);
}

function enrichVictim(
  db: Db,
  victim: Record<string, unknown>,
  characters: Map<number, CharacterPublicInfo | null>,
  corporations: Map<number, CorporationPublicInfo | null>,
  alliances: Map<number, AlliancePublicInfo | null>,
  factions: Map<number, FactionInfo | null>,
  prices: Map<number, MarketPrice>,
): Record<string, unknown> {
  const participant = enrichParticipant(db, victim, characters, corporations, alliances, factions, prices);
  const items = asRecordArray(victim.items).map((item) => enrichItem(db, item, prices));
  const fit = buildVictimFit(items);
  const pricing = summarizeItemsPricing(items, readNumeric(victim, 'ship_type_id'), prices, db);

  return {
    ...participant,
    items,
    fit,
    pricing,
  };
}

function enrichParticipant(
  db: Db,
  participant: Record<string, unknown>,
  characters: Map<number, CharacterPublicInfo | null>,
  corporations: Map<number, CorporationPublicInfo | null>,
  alliances: Map<number, AlliancePublicInfo | null>,
  factions: Map<number, FactionInfo | null>,
  prices: Map<number, MarketPrice>,
): Record<string, unknown> {
  const characterId = readNumeric(participant, 'character_id');
  const corporationId = readNumeric(participant, 'corporation_id');
  const allianceId = readNumeric(participant, 'alliance_id');
  const factionId = readNumeric(participant, 'faction_id');
  const shipTypeId = readNumeric(participant, 'ship_type_id');
  const weaponTypeId = readNumeric(participant, 'weapon_type_id');
  const character = characterId !== null ? characters.get(characterId) ?? null : null;
  const corporation = corporationId !== null ? corporations.get(corporationId) ?? null : null;
  const alliance = allianceId !== null ? alliances.get(allianceId) ?? null : null;
  const faction = factionId !== null ? factions.get(factionId) ?? null : null;
  const ship = resolveTypeInfo(db, shipTypeId, prices);
  const weapon = resolveTypeInfo(db, weaponTypeId, prices);
  const infoAction = characterId !== null
    ? buildInformationAction(characterId)
    : corporationId !== null
      ? buildInformationAction(corporationId)
      : allianceId !== null
        ? buildInformationAction(allianceId)
        : null;

  return {
    ...participant,
    character_id: characterId,
    character_name: character?.name ?? null,
    character_security_status: character?.security_status ?? readNumeric(participant, 'security_status'),
    corporation_id: corporationId,
    corporation_name: corporation?.name ?? null,
    corporation_ticker: corporation?.ticker ?? null,
    alliance_id: allianceId,
    alliance_name: alliance?.name ?? null,
    alliance_ticker: alliance?.ticker ?? null,
    faction_id: factionId,
    faction_name: faction?.name ?? null,
    ship: ship ? typeInfoToPublic(ship) : null,
    weapon: weapon ? typeInfoToPublic(weapon) : null,
    ui_actions: {
      open_information: infoAction?.open_information ?? null,
    },
    telegram_commands: infoAction?.telegram_commands ?? null,
  };
}

function enrichItem(
  db: Db,
  item: Record<string, unknown>,
  prices: Map<number, MarketPrice>,
): Record<string, unknown> {
  const typeId = readNumeric(item, 'item_type_id');
  const flag = readNumeric(item, 'flag');
  const quantityDropped = readNumeric(item, 'quantity_dropped') ?? 0;
  const quantityDestroyed = readNumeric(item, 'quantity_destroyed') ?? 0;
  const quantityTotal = Math.max(quantityDropped + quantityDestroyed, quantityDropped > 0 || quantityDestroyed > 0 ? 0 : 1);
  const type = resolveTypeInfo(db, typeId, prices);
  const flagInfo = resolveFlagInfo(db, flag);
  const containedItems = asRecordArray(item.items).map((entry) => enrichItem(db, entry, prices));
  const pricing = estimateTypeValue(typeId, prices, db);
  const linkMeta = type ? buildTypeLinkMeta(type.type_id, type.name) : null;
  const droppedValue = quantityDropped > 0 && pricing.unit_price !== null ? quantityDropped * pricing.unit_price : null;
  const destroyedValue = quantityDestroyed > 0 && pricing.unit_price !== null ? quantityDestroyed * pricing.unit_price : null;
  const containedValue = containedItems.reduce((sum, entry) => {
    const value = readNumeric(asRecord(entry.pricing), 'estimated_total_value');
    return sum + (value ?? 0);
  }, 0);

  return {
    ...item,
    item_type_id: typeId,
    type_name: type?.name ?? null,
    type: type ? typeInfoToPublic(type) : null,
    links: linkMeta,
    telegram_commands: linkMeta?.telegram_commands ?? null,
    ui_actions: type ? { open_market_details: buildMarketDetailsAction(type.type_id) } : { open_market_details: null },
    flag,
    flag_name: flagInfo?.name ?? null,
    slot_group: flagInfo?.slot_group ?? 'other',
    quantity_total: quantityTotal,
    pricing: {
      unit_price: pricing.unit_price,
      price_source: pricing.source,
      estimated_dropped_value: droppedValue,
      estimated_destroyed_value: destroyedValue,
      estimated_total_value: (droppedValue ?? 0) + (destroyedValue ?? 0) + containedValue,
    },
    items: containedItems,
  };
}

function buildVictimFit(items: Array<Record<string, unknown>>): Record<string, unknown> {
  const fit: Record<string, Array<Record<string, unknown>>> = {
    high_slots: [],
    mid_slots: [],
    low_slots: [],
    rig_slots: [],
    subsystem_slots: [],
    cargo: [],
    drone_bay: [],
    fighter_bay: [],
    implants: [],
    other: [],
  };

  for (const item of items) {
    const slotGroup = readString(item, 'slot_group') ?? 'other';
    const bucket = slotGroup in fit ? slotGroup : 'other';
    fit[bucket].push(item);
  }

  return fit;
}

function summarizeItemsPricing(
  items: Array<Record<string, unknown>>,
  shipTypeId: number | null,
  prices: Map<number, MarketPrice>,
  db: Db,
): Record<string, unknown> {
  let droppedValue = 0;
  let destroyedValue = 0;
  let pricedItems = 0;

  const walk = (entry: Record<string, unknown>) => {
    const pricing = asRecord(entry.pricing);
    const dropped = readNumeric(pricing, 'estimated_dropped_value') ?? 0;
    const destroyed = readNumeric(pricing, 'estimated_destroyed_value') ?? 0;
    const unitPrice = readNumeric(pricing, 'unit_price');
    if (unitPrice !== null) pricedItems += 1;
    droppedValue += dropped;
    destroyedValue += destroyed;
    for (const child of asRecordArray(entry.items)) {
      walk(child);
    }
  };
  for (const item of items) {
    walk(item);
  }

  const hullValue = estimateTypeValue(shipTypeId, prices, db);
  const estimatedTotalValue = (hullValue.unit_price ?? 0) + droppedValue + destroyedValue;

  return {
    ship_value: hullValue.unit_price,
    ship_value_source: hullValue.source,
    estimated_dropped_value: droppedValue,
    estimated_destroyed_value: destroyedValue,
    estimated_total_value: estimatedTotalValue > 0 ? estimatedTotalValue : null,
    priced_item_count: pricedItems,
  };
}

function deriveLinkedCharacterRole(
  linkedCharacterId: number | null,
  victim: Record<string, unknown>,
  attackers: Array<Record<string, unknown>>,
): string | null {
  if (!linkedCharacterId) return null;
  if (readNumeric(victim, 'character_id') === linkedCharacterId) {
    return 'victim';
  }
  const attacker = attackers.find((entry) => readNumeric(entry, 'character_id') === linkedCharacterId);
  if (!attacker) return null;
  return readBoolean(attacker, 'final_blow') ? 'final_blow' : 'attacker';
}

function participantLabel(participant: Record<string, unknown>): string | null {
  const characterName = readString(participant, 'character_name');
  const corporationName = readString(participant, 'corporation_name');
  const shipName = readString(asRecord(participant.ship), 'name');

  if (characterName && shipName) return `${characterName} (${shipName})`;
  if (characterName) return characterName;
  if (corporationName && shipName) return `${corporationName} (${shipName})`;
  return corporationName ?? shipName ?? null;
}

function normalizeCharacterInfo(characterId: number, data: JsonValue | null): CharacterPublicInfo | null {
  if (!isRecord(data)) return null;
  return {
    character_id: characterId,
    name: readString(data, 'name'),
    corporation_id: readNumeric(data, 'corporation_id'),
    alliance_id: readNumeric(data, 'alliance_id'),
    security_status: readNumeric(data, 'security_status'),
  };
}

function normalizeCorporationInfo(corporationId: number, data: JsonValue | null): CorporationPublicInfo | null {
  if (!isRecord(data)) return null;
  return {
    corporation_id: corporationId,
    name: readString(data, 'name'),
    ticker: readString(data, 'ticker'),
  };
}

function normalizeAllianceInfo(allianceId: number, data: JsonValue | null): AlliancePublicInfo | null {
  if (!isRecord(data)) return null;
  return {
    alliance_id: allianceId,
    name: readString(data, 'name'),
    ticker: readString(data, 'ticker'),
  };
}

function resolveSystemInfo(db: Db, systemId: number | null): SystemInfo | null {
  if (systemId === null) return null;
  const row = db.prepare(`
    SELECT
      s.system_id AS system_id,
      s.name AS system_name,
      s.data_json AS system_json,
      c.constellation_id AS constellation_id,
      c.name AS constellation_name,
      r.region_id AS region_id,
      r.name AS region_name
    FROM sde_systems s
    LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    LEFT JOIN sde_regions r ON r.region_id = c.region_id
    WHERE s.system_id = ?
  `).get(systemId) as
    | {
      system_id: number;
      system_name: string;
      system_json: string;
      constellation_id: number | null;
      constellation_name: string | null;
      region_id: number | null;
      region_name: string | null;
    }
    | undefined;
  if (!row) return null;

  const data = safeParse(row.system_json);
  const security = readNumeric(data, 'security_status')
    ?? readNumeric(data, 'true_security')
    ?? readNumeric(data, 'security');
  return {
    system_id: row.system_id,
    name: row.system_name,
    security,
    security_band: classifySecurityBand(security),
    constellation: row.constellation_id !== null ? { id: row.constellation_id, name: row.constellation_name } : null,
    region: row.region_id !== null ? { id: row.region_id, name: row.region_name } : null,
  };
}

function resolveFactionInfo(db: Db, factionId: number): FactionInfo | null {
  const row = db.prepare('SELECT name, data_json FROM sde_factions WHERE faction_id = ?').get(factionId) as
    | { name: string; data_json: string }
    | undefined;
  if (!row) return null;
  const data = safeParse(row.data_json);
  return {
    faction_id: factionId,
    name: localizeText(data.name) ?? row.name,
  };
}

function resolveTypeInfo(db: Db, typeId: number | null, prices: Map<number, MarketPrice>): TypeInfo | null {
  if (typeId === null) return null;
  const row = db.prepare(`
    SELECT
      t.type_id AS type_id,
      t.name AS type_name,
      t.group_id AS group_id,
      t.data_json AS type_json,
      json_extract(t.data_json, '$.market_group_id') AS market_group_id_raw,
      g.name AS group_name,
      c.category_id AS category_id,
      c.name AS category_name
    FROM sde_types t
    LEFT JOIN sde_groups g ON g.group_id = t.group_id
    LEFT JOIN sde_categories c ON c.category_id = g.category_id
    WHERE t.type_id = ?
  `).get(typeId) as
    | {
      type_id: number;
      type_name: string;
      group_id: number | null;
      type_json: string;
      market_group_id_raw: number | null;
      group_name: string | null;
      category_id: number | null;
      category_name: string | null;
    }
    | undefined;
  if (!row) return null;

  const data = safeParse(row.type_json);
  const price = prices.get(typeId);
  return {
    type_id: row.type_id,
    name: localizeText(data.name) ?? row.type_name,
    group: row.group_id !== null ? { id: row.group_id, name: row.group_name } : null,
    category: row.category_id !== null ? { id: row.category_id, name: row.category_name } : null,
    market_group_id: row.market_group_id_raw,
    base_price: price?.average_price ?? price?.adjusted_price ?? readNumeric(data, 'base_price') ?? readNumeric(data, 'basePrice'),
  };
}

function resolveFlagInfo(db: Db, flag: number | null): FlagInfo | null {
  if (flag === null) return null;
  const row = db.prepare(
    'SELECT name, data_json FROM sde_raw_records WHERE dataset_name = ? AND record_id = ?'
  ).get('invFlags', String(flag)) as { name: string | null; data_json: string } | undefined;
  if (!row) {
    return buildFallbackFlagInfo(flag);
  }

  const data = safeParse(row.data_json);
  const name = row.name ?? localizeText(data.name) ?? localizeText(data.text);
  if (!name) {
    return buildFallbackFlagInfo(flag);
  }
  return {
    flag,
    name,
    slot_group: classifyFlagSlotGroup(name),
  };
}

function estimateTypeValue(
  typeId: number | null,
  prices: Map<number, MarketPrice>,
  db: Db,
): { unit_price: number | null; source: string | null } {
  if (typeId === null) {
    return { unit_price: null, source: null };
  }
  const market = prices.get(typeId);
  if (market?.average_price !== null && market?.average_price !== undefined) {
    return { unit_price: market.average_price, source: 'esi.average_price' };
  }
  if (market?.adjusted_price !== null && market?.adjusted_price !== undefined) {
    return { unit_price: market.adjusted_price, source: 'esi.adjusted_price' };
  }
  const type = resolveTypeInfo(db, typeId, new Map());
  if (type?.base_price !== null && type?.base_price !== undefined) {
    return { unit_price: type.base_price, source: 'sde.basePrice' };
  }
  return { unit_price: null, source: null };
}

function typeInfoToPublic(type: TypeInfo): Record<string, unknown> {
  const linkMeta = buildTypeLinkMeta(type.type_id, type.name);
  return {
    id: type.type_id,
    name: type.name,
    group: type.group,
    category: type.category,
    estimated_unit_value: type.base_price,
    links: linkMeta,
    telegram_commands: linkMeta.telegram_commands,
    ui_actions: {
      open_market_details: buildMarketDetailsAction(type.type_id),
    },
  };
}

function classifySecurityBand(security: number | null): string | null {
  if (security === null) return null;
  if (security >= 0.5) return 'highsec';
  if (security > 0) return 'lowsec';
  return 'nullsec_or_special';
}

function classifyFlagSlotGroup(flagName: string | null): string {
  const value = (flagName ?? '').toLowerCase();
  if (value.includes('high slot') || value.includes('hi slot')) return 'high_slots';
  if (value.includes('medium slot') || value.includes('med slot') || value.includes('mid slot')) return 'mid_slots';
  if (value.includes('low slot')) return 'low_slots';
  if (value.includes('rig slot')) return 'rig_slots';
  if (value.includes('subsystem')) return 'subsystem_slots';
  if (value.includes('drone bay')) return 'drone_bay';
  if (value.includes('fighter')) return 'fighter_bay';
  if (value.includes('implant')) return 'implants';
  if (value.includes('cargo')) return 'cargo';
  return 'other';
}

function buildFallbackFlagInfo(flag: number): FlagInfo {
  if (flag === 5) {
    return { flag, name: 'Cargo', slot_group: 'cargo' };
  }
  if (flag >= 11 && flag <= 18) {
    return { flag, name: `Low Slot ${flag - 11}`, slot_group: 'low_slots' };
  }
  if (flag >= 19 && flag <= 26) {
    return { flag, name: `Mid Slot ${flag - 19}`, slot_group: 'mid_slots' };
  }
  if (flag >= 27 && flag <= 34) {
    return { flag, name: `High Slot ${flag - 27}`, slot_group: 'high_slots' };
  }
  if (flag === 87) {
    return { flag, name: 'Drone Bay', slot_group: 'drone_bay' };
  }
  if (flag >= 92 && flag <= 99) {
    return { flag, name: `Rig Slot ${flag - 92}`, slot_group: 'rig_slots' };
  }
  if (flag >= 125 && flag <= 132) {
    return { flag, name: `Subsystem Slot ${flag - 125}`, slot_group: 'subsystem_slots' };
  }
  return { flag, name: null, slot_group: 'other' };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function tryParseJson(text: string): JsonValue | null {
  try {
    const parsed = JSON.parse(text) as JsonValue;
    if (Array.isArray(parsed) || isRecord(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function isKillmailRef(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && readNumeric(value, 'killmail_id') !== null && !!readString(value, 'killmail_hash');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function readField(obj: Record<string, unknown>, snakeCase: string): unknown {
  if (snakeCase in obj) return obj[snakeCase];
  const camel = snakeCase.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  if (camel in obj) return obj[camel];
  const camelId = camel.replace(/Id$/, 'ID');
  if (camelId in obj) return obj[camelId];
  return undefined;
}

function readNumeric(obj: Record<string, unknown>, snakeCase: string): number | null {
  const value = readField(obj, snakeCase);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readString(obj: Record<string, unknown>, snakeCase: string): string | null {
  const value = readField(obj, snakeCase);
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readBoolean(obj: Record<string, unknown>, snakeCase: string): boolean | null {
  const value = readField(obj, snakeCase);
  return typeof value === 'boolean' ? value : null;
}

function safeParse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function localizeText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  const preferred = value.ru ?? value.en ?? value['en-us'];
  if (typeof preferred === 'string') return preferred;
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}
