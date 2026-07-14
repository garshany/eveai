import type {
  BatchEntityStats,
  CharacterTopShip,
  EntityStats,
  FeedEvent,
  FeedPage,
  KillmailEntity,
  KillmailItem,
  KillmailPage,
  NormalizedKillmail,
  Pagination,
  Position3d,
} from './types.js';

export function parseKillmailSummary(value: unknown): NormalizedKillmail {
  const row = record(value, 'killmail summary');
  const victim: KillmailEntity = compact({
    characterId: optionalPositiveInt(row.victim_character_id),
    corporationId: positiveInt(row.victim_corporation_id, 'victim_corporation_id'),
    allianceId: optionalPositiveInt(row.victim_alliance_id),
    characterName: optionalString(row.victim_character_name),
    corporationName: optionalString(row.victim_corporation_name),
    allianceName: optionalString(row.victim_alliance_name),
    shipTypeId: positiveInt(row.ship_type_id, 'ship_type_id'),
    shipName: optionalString(row.ship_name),
    shipGroupName: optionalString(row.ship_group_name),
  });
  const finalBlow = compact<KillmailEntity>({
    characterId: optionalPositiveInt(row.final_blow_character_id),
    corporationId: optionalPositiveInt(row.final_blow_corporation_id),
    allianceId: optionalPositiveInt(row.final_blow_alliance_id),
    characterName: optionalString(row.final_blow_character_name),
    corporationName: optionalString(row.final_blow_corporation_name),
    allianceName: optionalString(row.final_blow_alliance_name),
    finalBlow: true,
  });
  const attackerCount = optionalNonNegativeInt(row.attacker_count) ?? (Object.keys(finalBlow).length > 1 ? 1 : 0);

  return {
    killmailId: positiveInt(row.killmail_id, 'killmail_id'),
    killmailHash: optionalString(row.killmail_hash),
    killmailTime: date(row.killmail_time, 'killmail_time'),
    solarSystemId: positiveInt(row.solar_system_id, 'solar_system_id'),
    solarSystemName: optionalString(row.solar_system_name),
    solarSystemSecurity: optionalFinite(row.solar_system_security),
    constellationId: optionalPositiveInt(row.constellation_id),
    regionId: optionalPositiveInt(row.region_id),
    regionName: optionalString(row.region_name),
    totalValue: optionalFinite(row.total_value),
    attackerCount,
    isNpc: optionalBoolean(row.is_npc),
    isSolo: optionalBoolean(row.is_solo),
    victim,
    attackers: Object.keys(finalBlow).length > 1 ? [finalBlow] : [],
    items: [],
    siblings: [],
    sourceShape: 'summary',
  };
}

export function parseEsiKillmail(value: unknown, sourceShape: 'esi' | 'feed' = 'esi'): NormalizedKillmail {
  const row = record(value, 'ESI killmail');
  const victimRow = record(row.victim, 'victim');
  const attackers = array(row.attackers, 'attackers').map(parseEsiAttacker);
  const items = Array.isArray(victimRow.items) ? victimRow.items.map(parseEsiItem) : [];
  const victim = parseEsiVictim(victimRow);
  const playerAttackers = attackers.filter((attacker) => attacker.characterId !== undefined);

  return {
    killmailId: positiveInt(row.killmail_id, 'killmail_id'),
    killmailHash: optionalString(row.killmail_hash),
    killmailTime: date(row.killmail_time, 'killmail_time'),
    solarSystemId: positiveInt(row.solar_system_id, 'solar_system_id'),
    constellationId: optionalPositiveInt(row.constellation_id),
    regionId: optionalPositiveInt(row.region_id),
    attackerCount: attackers.length,
    isNpc: attackers.length > 0 ? playerAttackers.length === 0 : undefined,
    isSolo: attackers.length > 0 ? playerAttackers.length === 1 : undefined,
    victim,
    attackers,
    items,
    position: parsePosition(victimRow.position),
    siblings: [],
    sourceShape,
  };
}

export function parseKillmailDetail(value: unknown): NormalizedKillmail {
  const row = record(value, 'killmail detail');
  const victimRow = record(row.victim, 'victim');
  const victim = parseDetailEntity(victimRow);
  const attackers = array(row.attackers, 'attackers').map((entry) => parseDetailEntity(record(entry, 'attacker')));
  const items = Array.isArray(row.items) ? row.items.map(parseDetailItem) : [];
  const siblings = Array.isArray(row.siblings)
    ? row.siblings.map((entry) => {
      try { return parseKillmailSummary(entry); } catch { return null; }
    }).filter((entry): entry is NormalizedKillmail => entry !== null)
    : [];

  return {
    killmailId: positiveInt(row.killmail_id, 'killmail_id'),
    killmailHash: optionalString(row.killmail_hash),
    killmailTime: date(row.killmail_time, 'killmail_time'),
    solarSystemId: positiveInt(row.solar_system_id, 'solar_system_id'),
    solarSystemName: optionalString(row.solar_system_name),
    solarSystemSecurity: optionalFinite(row.solar_system_security),
    constellationId: optionalPositiveInt(row.constellation_id),
    regionId: optionalPositiveInt(row.region_id),
    regionName: optionalString(row.region_name),
    totalValue: optionalFinite(row.total_value),
    fittedValue: optionalFinite(row.fitted_value),
    droppedValue: optionalFinite(row.dropped_value),
    destroyedValue: optionalFinite(row.destroyed_value),
    points: optionalFinite(row.points),
    attackerCount: optionalNonNegativeInt(row.attacker_count) ?? attackers.length,
    isNpc: optionalBoolean(row.is_npc),
    isSolo: optionalBoolean(row.is_solo),
    victim,
    attackers,
    items,
    position: parsePosition(victimRow.position),
    siblings,
    sourceShape: 'detail',
  };
}

export function parseKillmailPage(value: unknown): KillmailPage {
  const row = record(value, 'killmail page');
  const kills = array(row.data, 'data').map(parseKillmailSummary);
  return { kills, pagination: parsePagination(row.pagination) };
}

export function parseSearchPage(value: unknown): KillmailPage {
  const row = record(value, 'killmail search page');
  const kills = array(row.data, 'data').map((entry) => parseEsiKillmail(entry));
  return { kills, pagination: parsePagination(row.pagination) };
}

export function parseFeedPage(value: unknown): FeedPage {
  const row = record(value, 'feed page');
  const latest = nonNegativeInt(row.latest, 'latest');
  const events: FeedEvent[] = array(row.data, 'data').map((entry) => {
    const event = record(entry, 'feed event');
    const sequenceId = positiveInt(event.seq, 'seq');
    const killmail = parseEsiKillmail(event.data, 'feed');
    const outerId = positiveInt(event.killmail_id, 'killmail_id');
    if (outerId !== killmail.killmailId) throw new Error('feed event killmail_id mismatch');
    const outerHash = string(event.killmail_hash, 'killmail_hash');
    if (killmail.killmailHash && outerHash !== killmail.killmailHash) {
      throw new Error('feed event killmail_hash mismatch');
    }
    if (!killmail.killmailHash) killmail.killmailHash = outerHash;
    return { sequenceId, killmail };
  });
  for (let i = 1; i < events.length; i += 1) {
    if (events[i]!.sequenceId <= events[i - 1]!.sequenceId) {
      throw new Error('feed events are not strictly increasing');
    }
  }
  if (events.length > 0 && latest < events[events.length - 1]!.sequenceId) {
    throw new Error('feed latest sequence is behind returned events');
  }
  return {
    events,
    latest,
    hasMore: boolean(row.hasMore, 'hasMore'),
    next: optionalString(row.next) ?? null,
    last: optionalString(row.last) ?? null,
  };
}

export function parseBatchEntityStats(value: unknown): Pick<BatchEntityStats, 'period' | 'results'> {
  const row = record(value, 'batch entity stats');
  const period = string(row.period, 'period');
  const results = array(row.results, 'results').map((entry) => parseEntityStats(entry, period));
  return { period, results };
}

export function parseEntityStats(value: unknown, fallbackPeriod?: string): EntityStats {
  const row = record(value, 'entity stats');
  const id = optionalPositiveInt(row.id) ?? optionalPositiveInt(row.character_id)
    ?? optionalPositiveInt(row.corporation_id) ?? optionalPositiveInt(row.alliance_id);
  if (!id) throw new Error('entity stats missing id');
  const topShips = Array.isArray(row.topShips) ? row.topShips.map(parseTopShip) : [];
  return {
    id,
    name: optionalString(row.name),
    period: optionalString(row.period) ?? fallbackPeriod,
    kills: optionalNonNegativeInt(row.kills) ?? 0,
    losses: optionalNonNegativeInt(row.losses) ?? 0,
    soloKills: optionalNonNegativeInt(row.solo_kills) ?? 0,
    npcLosses: optionalNonNegativeInt(row.npc_losses) ?? 0,
    iskDestroyed: optionalFinite(row.isk_destroyed) ?? 0,
    iskLost: optionalFinite(row.isk_lost) ?? 0,
    efficiency: optionalFinite(row.efficiency),
    iskEfficiency: optionalFinite(row.isk_efficiency),
    topShips,
  };
}

function parseTopShip(value: unknown): CharacterTopShip {
  const row = record(value, 'top ship');
  return {
    shipTypeId: positiveInt(row.ship_type_id, 'ship_type_id'),
    shipName: optionalString(row.ship_name),
    kills: optionalNonNegativeInt(row.kills) ?? 0,
    losses: optionalNonNegativeInt(row.losses) ?? 0,
  };
}

function parsePagination(value: unknown): Pagination {
  const row = record(value, 'pagination');
  const hasMore = boolean(row.hasMore, 'pagination.hasMore');
  const cursor = row.cursor == null ? null : positiveInt(row.cursor, 'pagination.cursor');
  if (hasMore && cursor === null) throw new Error('pagination cursor is required when hasMore is true');
  return { hasMore, cursor };
}

function parseEsiVictim(row: Record<string, unknown>): KillmailEntity {
  return compact({
    characterId: optionalPositiveInt(row.character_id),
    corporationId: optionalPositiveInt(row.corporation_id),
    allianceId: optionalPositiveInt(row.alliance_id),
    factionId: optionalPositiveInt(row.faction_id),
    shipTypeId: positiveInt(row.ship_type_id, 'victim.ship_type_id'),
    damageTaken: nonNegativeFinite(row.damage_taken, 'victim.damage_taken'),
  });
}

function parseEsiAttacker(value: unknown): KillmailEntity {
  const row = record(value, 'attacker');
  return compact({
    characterId: optionalPositiveInt(row.character_id),
    corporationId: optionalPositiveInt(row.corporation_id),
    allianceId: optionalPositiveInt(row.alliance_id),
    factionId: optionalPositiveInt(row.faction_id),
    shipTypeId: optionalPositiveInt(row.ship_type_id),
    weaponTypeId: optionalPositiveInt(row.weapon_type_id),
    damageDone: nonNegativeFinite(row.damage_done, 'attacker.damage_done'),
    finalBlow: boolean(row.final_blow, 'attacker.final_blow'),
  });
}

function parseDetailEntity(row: Record<string, unknown>): KillmailEntity {
  return compact({
    characterId: optionalPositiveInt(row.character_id),
    corporationId: optionalPositiveInt(row.corporation_id),
    allianceId: optionalPositiveInt(row.alliance_id),
    factionId: optionalPositiveInt(row.faction_id),
    characterName: optionalString(row.character_name),
    corporationName: optionalString(row.corporation_name),
    allianceName: optionalString(row.alliance_name),
    factionName: optionalString(row.faction_name),
    shipTypeId: optionalPositiveInt(row.ship_type_id),
    shipName: optionalString(row.ship_name),
    shipGroupName: optionalString(row.ship_group_name),
    weaponTypeId: optionalPositiveInt(row.weapon_type_id),
    weaponName: optionalString(row.weapon_name),
    damageDone: optionalFinite(row.damage_done),
    damageTaken: optionalFinite(row.damage_taken),
    finalBlow: optionalBoolean(row.final_blow),
  });
}

function parseEsiItem(value: unknown): KillmailItem {
  const row = record(value, 'killmail item');
  return {
    typeId: positiveInt(row.item_type_id, 'item_type_id'),
    flag: optionalNonNegativeInt(row.flag),
    quantityDropped: optionalNonNegativeInt(row.quantity_dropped) ?? 0,
    quantityDestroyed: optionalNonNegativeInt(row.quantity_destroyed) ?? 0,
    singleton: optionalNonNegativeInt(row.singleton),
  };
}

function parseDetailItem(value: unknown): KillmailItem {
  const row = record(value, 'killmail detail item');
  return {
    typeId: positiveInt(row.type_id, 'type_id'),
    typeName: optionalString(row.type_name),
    flag: optionalNonNegativeInt(row.flag_id),
    flagName: optionalString(row.flag_name),
    quantityDropped: optionalNonNegativeInt(row.quantity_dropped) ?? 0,
    quantityDestroyed: optionalNonNegativeInt(row.quantity_destroyed) ?? 0,
    singleton: optionalNonNegativeInt(row.singleton),
    price: optionalFinite(row.price),
    totalValue: optionalFinite(row.total_value),
  };
}

function parsePosition(value: unknown): Position3d | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('victim.position must be an object');
  const row = value as Record<string, unknown>;
  return {
    x: finite(row.x, 'victim.position.x'),
    y: finite(row.y, 'victim.position.y'),
    z: finite(row.z, 'victim.position.z'),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error('optional string field must be a non-empty string');
  return value;
}

function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isCanonicalIsoTimestamp(value)) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp with an explicit timezone`);
  }
  return value;
}

const CANONICAL_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function isCanonicalIsoTimestamp(value: string): boolean {
  const match = CANONICAL_ISO_TIMESTAMP.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (offsetHour > 23 || offsetMinute > 59) return false;

  // Validate the calendar fields without Date.parse's rollover behavior
  // (for example, February 30). setUTCFullYear avoids Date.UTC's 0-99 quirk.
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day
    && Number.isFinite(Date.parse(value));
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('optional id field must be a positive integer');
  }
  return value;
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('optional integer field must be a non-negative integer');
  }
  return value;
}

function optionalFinite(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return finite(value, 'optional numeric field');
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error('optional boolean field must be boolean');
  return value;
}

function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
