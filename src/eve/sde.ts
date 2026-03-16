import type { Db } from '../db/sqlite.js';
import { buildMarketDetailsAction, buildTypeLinkMeta } from './eve-links.js';

export type SdeEntity =
  | 'type' | 'group' | 'category' | 'market_group' | 'meta_group'
  | 'dogma_attribute' | 'dogma_effect' | 'dogma_unit'
  | 'certificate' | 'mastery'
  | 'faction' | 'race'
  | 'npc_corporation'
  | 'dataset'
  | 'region' | 'constellation' | 'system' | 'station'
  | 'blueprint';

export type LookupMode = 'by_id' | 'by_name' | 'search';

export interface SdeRequest {
  entity: SdeEntity;
  lookup_mode: LookupMode;
  value: string;
  limit: number;
  dataset?: string | null;
}

export interface SdeResult {
  ok: boolean;
  count: number;
  items: Record<string, unknown>[];
  error: string | null;
}

type NamedTableMap = { table: string; idCol: string; nameCol: string };
type NamedRow = { id: number; name: string; data_json: string };
type NamedEntity = Exclude<SdeEntity, 'dataset'>;

const TABLE_MAP: Record<NamedEntity, NamedTableMap> = {
  type:             { table: 'sde_types',             idCol: 'type_id',           nameCol: 'name' },
  group:            { table: 'sde_groups',            idCol: 'group_id',          nameCol: 'name' },
  category:         { table: 'sde_categories',        idCol: 'category_id',       nameCol: 'name' },
  market_group:     { table: 'sde_market_groups',     idCol: 'market_group_id',   nameCol: 'name' },
  meta_group:       { table: 'sde_meta_groups',       idCol: 'meta_group_id',     nameCol: 'name' },
  dogma_attribute:  { table: 'sde_dogma_attributes',  idCol: 'attribute_id',      nameCol: 'name' },
  dogma_effect:     { table: 'sde_dogma_effects',     idCol: 'effect_id',         nameCol: 'name' },
  dogma_unit:       { table: 'sde_dogma_units',       idCol: 'unit_id',           nameCol: 'name' },
  certificate:      { table: 'sde_certificates',      idCol: 'certificate_id',    nameCol: 'name' },
  mastery:          { table: 'sde_masteries',         idCol: 'type_id',           nameCol: 'name' },
  faction:          { table: 'sde_factions',          idCol: 'faction_id',        nameCol: 'name' },
  race:             { table: 'sde_races',             idCol: 'race_id',           nameCol: 'name' },
  npc_corporation:  { table: 'sde_npc_corporations',  idCol: 'corporation_id',    nameCol: 'name' },
  region:           { table: 'sde_regions',           idCol: 'region_id',         nameCol: 'name' },
  constellation:    { table: 'sde_constellations',    idCol: 'constellation_id',  nameCol: 'name' },
  system:           { table: 'sde_systems',           idCol: 'system_id',         nameCol: 'name' },
  station:          { table: 'sde_stations',          idCol: 'station_id',        nameCol: 'name' },
  blueprint:        { table: 'sde_blueprints',        idCol: 'blueprint_type_id', nameCol: 'name' },
};

/**
 * Shared SDE lookup implementation for model-facing SDE tools.
 * Returns both the base SDE entity and resolved relations that are cheap and useful
 * for agent answers (groups/categories, region chains, dogma skills/bonuses, etc.).
 */
export function querySde(db: Db, req: SdeRequest): SdeResult {
  if (req.entity === 'dataset') {
    return queryRawDataset(db, req);
  }

  const mapping = TABLE_MAP[req.entity];
  if (!mapping) {
    return { ok: false, count: 0, items: [], error: `Unknown entity: ${req.entity}` };
  }

  const limitRaw = Number(req.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

  try {
    const rows = queryNamedRows(db, mapping, req.lookup_mode, req.value, limit);
    const detailed = rows.length <= 3 && req.lookup_mode !== 'search';

    const items = rows.map((row) => enrichItem(db, req.entity, mergeNamedRow(row), detailed));
    return { ok: true, count: items.length, items, error: null };
  } catch (err) {
    return { ok: false, count: 0, items: [], error: `SDE query error: ${(err as Error).message}` };
  }
}

function queryRawDataset(db: Db, req: SdeRequest): SdeResult {
  const dataset = req.dataset?.trim();
  if (!dataset) {
    return { ok: false, count: 0, items: [], error: 'dataset entity requires dataset name' };
  }

  const limitRaw = Number(req.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

  try {
    let rows: Array<{ record_id: string; name: string | null; data_json: string }> = [];
    switch (req.lookup_mode) {
      case 'by_id':
        rows = db.prepare(
          'SELECT record_id, name, data_json FROM sde_raw_records WHERE dataset_name = ? AND record_id = ? LIMIT ?'
        ).all(dataset, req.value, limit) as Array<{ record_id: string; name: string | null; data_json: string }>;
        break;
      case 'by_name':
        rows = db.prepare(
          'SELECT record_id, name, data_json FROM sde_raw_records WHERE dataset_name = ? AND name = ? COLLATE NOCASE LIMIT ?'
        ).all(dataset, req.value, limit) as Array<{ record_id: string; name: string | null; data_json: string }>;
        break;
      case 'search':
        rows = db.prepare(
          'SELECT record_id, name, data_json FROM sde_raw_records WHERE dataset_name = ? AND COALESCE(name, \'\') LIKE ? COLLATE NOCASE LIMIT ?'
        ).all(dataset, `%${req.value}%`, limit) as Array<{ record_id: string; name: string | null; data_json: string }>;
        break;
    }

    const items = rows.map((row) => {
      const data = safeParse(row.data_json);
      return {
        dataset,
        id: row.record_id,
        name: row.name,
        ...data,
      };
    });
    return { ok: true, count: items.length, items, error: null };
  } catch (err) {
    return { ok: false, count: 0, items: [], error: `SDE query error: ${(err as Error).message}` };
  }
}

function queryNamedRows(
  db: Db,
  mapping: NamedTableMap,
  lookupMode: LookupMode,
  value: string,
  limit: number,
): NamedRow[] {
  switch (lookupMode) {
    case 'by_id': {
      const id = Number(value);
      if (isNaN(id)) {
        throw new Error('by_id requires a numeric value');
      }
      return db.prepare(
        `SELECT ${mapping.idCol} AS id, ${mapping.nameCol} AS name, data_json FROM ${mapping.table} WHERE ${mapping.idCol} = ?`
      ).all(id) as NamedRow[];
    }
    case 'by_name':
      return db.prepare(
        `SELECT ${mapping.idCol} AS id, ${mapping.nameCol} AS name, data_json
         FROM ${mapping.table}
         WHERE ${mapping.nameCol} = ? COLLATE NOCASE
         LIMIT ?`
      ).all(value, limit) as NamedRow[];
    case 'search':
      return db.prepare(
        `SELECT ${mapping.idCol} AS id, ${mapping.nameCol} AS name, data_json
         FROM ${mapping.table}
         WHERE ${mapping.nameCol} LIKE ? COLLATE NOCASE
         LIMIT ?`
      ).all(`%${value}%`, limit) as NamedRow[];
    default:
      throw new Error(`Unknown lookup_mode: ${lookupMode satisfies never}`);
  }
}

function mergeNamedRow(row: NamedRow): Record<string, unknown> {
  const data = safeParse(row.data_json);
  if ('name' in data) {
    delete data.name;
  }
  const merged: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    ...data,
  };

  const localizedName = localizeText(data.name);
  if (localizedName) {
    merged.name_text = localizedName;
  }
  const descriptionText = localizeText(data.description);
  if (descriptionText) {
    merged.description_text = descriptionText;
  }
  const shortDescriptionText = localizeText(data.shortDescription);
  if (shortDescriptionText) {
    merged.short_description_text = shortDescriptionText;
  }

  return merged;
}

function enrichItem(db: Db, entity: SdeEntity, item: Record<string, unknown>, detailed: boolean): Record<string, unknown> {
  switch (entity) {
    case 'type':
      return enrichType(db, item, detailed);
    case 'group':
      return enrichGroup(db, item);
    case 'market_group':
      return enrichMarketGroup(db, item);
    case 'certificate':
      return enrichCertificate(db, item);
    case 'mastery':
      return enrichMastery(db, item);
    case 'faction':
      return enrichFaction(db, item);
    case 'race':
      return enrichRace(db, item);
    case 'npc_corporation':
      return enrichNpcCorporation(db, item);
    case 'constellation':
      return enrichConstellation(db, item);
    case 'system':
      return enrichSystem(db, item);
    case 'station':
      return enrichStation(db, item);
    case 'blueprint':
      return enrichBlueprint(db, item);
    default:
      return item;
  }
}

function enrichType(db: Db, item: Record<string, unknown>, detailed: boolean): Record<string, unknown> {
  const enriched = { ...item };
  const related: Record<string, unknown> = {};

  const groupId = readNumeric(item, 'group_id');
  const marketGroupId = readNumeric(item, 'market_group_id');
  const factionId = readNumeric(item, 'faction_id');
  const metaGroupId = readNumeric(item, 'meta_group_id');
  const typeId = readNumeric(item, 'type_id') ?? readNumeric(item, 'id');

  if (typeId !== null) {
    const linkMeta = buildTypeLinkMeta(typeId, typeof enriched.name === 'string' ? enriched.name : null);
    enriched.links = linkMeta;
    enriched.telegram_commands = linkMeta.telegram_commands;
    enriched.ui_actions = {
      open_market_details: buildMarketDetailsAction(typeId),
    };
  }

  if (groupId !== null) {
    const group = resolveNamedEntity(db, 'group', groupId);
    if (group) {
      related.group = group;
      const categoryId = readNumeric(group, 'category_id');
      if (categoryId !== null) {
        const category = resolveNamedEntity(db, 'category', categoryId);
        if (category) {
          related.category = category;
        }
      }
    }
  }

  if (marketGroupId !== null) {
    const marketGroup = resolveNamedEntity(db, 'market_group', marketGroupId);
    if (marketGroup) {
      related.market_group = marketGroup;
      related.market_group_chain = buildMarketGroupChain(db, marketGroupId);
    }
  }

  if (factionId !== null) {
    const faction = enrichFaction(db, resolveNamedEntity(db, 'faction', factionId) ?? {});
    if (Object.keys(faction).length > 0) {
      related.faction = faction;
    }
  }

  if (metaGroupId !== null) {
    const metaGroup = resolveNamedEntity(db, 'meta_group', metaGroupId);
    if (metaGroup) {
      related.meta_group = metaGroup;
    }
  }

  if (typeId !== null) {
    const bonus = resolveTypeBonus(db, typeId);
    if (bonus) {
      enriched.bonuses = bonus;
    }

    const dogma = resolveTypeDogma(db, typeId, detailed);
    if (dogma) {
      enriched.required_skills = dogma.requiredSkills;
      enriched.dogma = {
        attributes: dogma.attributes,
        effects: dogma.effects,
      };
    }

    const materials = resolveTypeMaterials(db, typeId);
    if (materials.length > 0) {
      related.materials = materials;
    }

    const masteries = resolveTypeMasteries(db, typeId);
    if (masteries.length > 0) {
      enriched.masteries = masteries;
    }

    const skins = resolveTypeSkins(db, typeId);
    if (skins.length > 0) {
      related.skins = skins;
    }

    const schematics = resolveTypePlanetSchematics(db, typeId);
    if (schematics.inputs.length > 0 || schematics.outputs.length > 0) {
      related.planetary_industry = schematics;
    }
  }

  if (Object.keys(related).length > 0) {
    enriched.related = related;
  }

  return enriched;
}

function enrichCertificate(_db: Db, item: Record<string, unknown>): Record<string, unknown> {
  return item;
}

function enrichMastery(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  const typeId = readNumeric(item, 'type_id') ?? readNumeric(item, 'id');
  if (typeId === null) return item;
  return {
    ...item,
    related: {
      levels: resolveTypeMasteries(db, typeId),
    },
  };
}

function enrichGroup(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  const enriched = { ...item };
  const categoryId = readNumeric(item, 'category_id');
  if (categoryId !== null) {
    const category = resolveNamedEntity(db, 'category', categoryId);
    if (category) {
      enriched.related = { category };
    }
  }
  return enriched;
}

function enrichMarketGroup(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  const enriched = { ...item };
  const marketGroupId = readNumeric(item, 'market_group_id') ?? readNumeric(item, 'id');
  if (marketGroupId !== null) {
    enriched.related = { chain: buildMarketGroupChain(db, marketGroupId) };
  }
  return enriched;
}

function enrichFaction(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(item).length === 0) return item;

  const enriched = { ...item };
  const memberRaces = asNumberArray(readField(item, 'member_races'));
  if (memberRaces.length > 0) {
    enriched.related = {
      member_races: memberRaces
        .map((raceId) => enrichRace(db, resolveNamedEntity(db, 'race', raceId) ?? {}))
        .filter((race) => Object.keys(race).length > 0),
    };
  }
  return enriched;
}

function enrichRace(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(item).length === 0) return item;

  const enriched = { ...item };
  const shipTypeId = readNumeric(item, 'ship_type_id');
  if (shipTypeId !== null) {
    const shipType = resolveNamedEntity(db, 'type', shipTypeId);
    if (shipType) {
      enriched.related = {
        ship_type: {
          id: shipType.id,
          name: shipType.name,
        },
      };
    }
  }
  return enriched;
}

function enrichNpcCorporation(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  const enriched = { ...item };
  const stationId = readNumeric(item, 'station_id');
  if (stationId === null) return enriched;

  const station = enrichStation(db, resolveNamedEntity(db, 'station', stationId) ?? {});
  if (Object.keys(station).length > 0) {
    enriched.related = { station };
    const stationRelated = asRecord(station.related);
    if (stationRelated.system && typeof stationRelated.system === 'object') {
      enriched.related = {
        ...asRecord(enriched.related),
        system: stationRelated.system,
      };
    }
    if (stationRelated.region && typeof stationRelated.region === 'object') {
      enriched.related = {
        ...asRecord(enriched.related),
        region: stationRelated.region,
      };
    }
  }
  return enriched;
}

function enrichConstellation(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  const enriched = { ...item };
  const regionId = readNumeric(item, 'region_id');
  if (regionId !== null) {
    const region = resolveNamedEntity(db, 'region', regionId);
    if (region) {
      enriched.related = { region };
    }
  }
  return enriched;
}

function enrichSystem(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  const enriched = { ...item };
  const constellationId = readNumeric(item, 'constellation_id');
  if (constellationId === null) {
    return enriched;
  }

  const constellation = enrichConstellation(db, resolveNamedEntity(db, 'constellation', constellationId) ?? {});
  const related: Record<string, unknown> = {};
  if (Object.keys(constellation).length > 0) {
    related.constellation = constellation;
    const region = asRecord(constellation.related)?.region;
    if (region && typeof region === 'object') {
      related.region = region;
    }
  }
  if (Object.keys(related).length > 0) {
    enriched.related = related;
  }

  const stargates = resolveSystemStargates(db, readNumeric(item, 'system_id') ?? readNumeric(item, 'id'));
  if (stargates.length > 0) {
    enriched.related = {
      ...asRecord(enriched.related),
      stargates,
    };
  }

  const planets = resolveSystemPlanets(db, readNumeric(item, 'system_id') ?? readNumeric(item, 'id'));
  if (planets.length > 0) {
    enriched.related = {
      ...asRecord(enriched.related),
      planets,
    };
  }
  return enriched;
}

function enrichStation(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  const enriched = { ...item };
  const systemId = readNumeric(item, 'system_id');
  if (systemId === null) {
    return enriched;
  }

  const system = enrichSystem(db, resolveNamedEntity(db, 'system', systemId) ?? {});
  const related: Record<string, unknown> = {};
  if (Object.keys(system).length > 0) {
    related.system = system;
    const systemRelated = asRecord(system.related);
    if (systemRelated.constellation && typeof systemRelated.constellation === 'object') {
      related.constellation = systemRelated.constellation;
    }
    if (systemRelated.region && typeof systemRelated.region === 'object') {
      related.region = systemRelated.region;
    }
  }
  if (Object.keys(related).length > 0) {
    enriched.related = related;
  }
  return enriched;
}

function enrichBlueprint(db: Db, item: Record<string, unknown>): Record<string, unknown> {
  const enriched = { ...item };
  const activities = asRecord(readField(item, 'activities'));
  if (Object.keys(activities).length === 0) {
    return enriched;
  }

  const resolvedActivities: Record<string, unknown> = {};
  for (const [activityName, rawActivity] of Object.entries(activities)) {
    const activity = asRecord(rawActivity);
    const resolved: Record<string, unknown> = { ...activity };

    const materials = asRecordArray(activity.materials).map((entry) => ({
      ...entry,
      type: resolveTypeRef(db, readNumeric(entry, 'type_id')),
    }));
    if (materials.length > 0) {
      resolved.materials = materials;
    }

    const products = asRecordArray(activity.products).map((entry) => ({
      ...entry,
      type: resolveTypeRef(db, readNumeric(entry, 'type_id')),
    }));
    if (products.length > 0) {
      resolved.products = products;
    }

    resolvedActivities[activityName] = resolved;
  }

  if (Object.keys(resolvedActivities).length > 0) {
    enriched.related = { activities: resolvedActivities };
  }

  return enriched;
}

function resolveNamedEntity(db: Db, entity: NamedEntity, id: number): Record<string, unknown> | null {
  const mapping = TABLE_MAP[entity];
  const row = db.prepare(
    `SELECT ${mapping.idCol} AS id, ${mapping.nameCol} AS name, data_json FROM ${mapping.table} WHERE ${mapping.idCol} = ?`
  ).get(id) as NamedRow | undefined;
  return row ? mergeNamedRow(row) : null;
}

function buildMarketGroupChain(db: Db, marketGroupId: number): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let currentId: number | null = marketGroupId;
  const seen = new Set<number>();

  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    const group = resolveNamedEntity(db, 'market_group', currentId);
    if (!group) break;
    chain.unshift({ id: group.id, name: group.name });
    currentId = readNumeric(group, 'parent_group_id');
  }

  return chain;
}

function resolveTypeBonus(db: Db, typeId: number): Record<string, unknown> | null {
  const row = db.prepare('SELECT data_json FROM sde_type_bonus WHERE type_id = ?').get(typeId) as
    | { data_json: string }
    | undefined;
  if (!row) return null;

  const data = safeParse(row.data_json);
  const roleBonuses = asRecordArray(data.roleBonuses).map(normalizeBonus);
  const skillBonuses = asRecordArray(data.types).map((entry) => {
    const skillTypeId = readNumeric(entry, '_key');
    return {
      skill: resolveTypeRef(db, skillTypeId),
      bonuses: asRecordArray(entry._value).map(normalizeBonus),
    };
  }).filter((entry) => entry.skill !== null);

  return {
    role_bonuses: roleBonuses,
    skill_bonuses: skillBonuses,
  };
}

function resolveTypeMaterials(db: Db, typeId: number): Array<Record<string, unknown>> {
  const row = db.prepare('SELECT data_json FROM sde_type_materials WHERE type_id = ?').get(typeId) as
    | { data_json: string }
    | undefined;
  if (!row) return [];

  const data = safeParse(row.data_json);
  return asRecordArray(data.materials).map((entry) => ({
    ...entry,
    type: resolveTypeRef(db, readNumeric(entry, 'material_type_id')),
  }));
}

function resolveTypeMasteries(db: Db, typeId: number): Array<Record<string, unknown>> {
  const row = db.prepare('SELECT data_json FROM sde_masteries WHERE type_id = ?').get(typeId) as
    | { data_json: string }
    | undefined;
  if (!row) return [];

  const data = safeParse(row.data_json);
  return asRecordArray(data._value)
    .map((entry) => ({
      level: readNumeric(entry, '_key'),
      certificates: asNumberArray(entry._value).map((certificateId) => {
        const certificate = resolveNamedEntity(db, 'certificate', certificateId);
        return certificate ? { id: certificate.id, name: certificate.name } : { id: certificateId, name: null };
      }),
    }))
    .filter((entry) => entry.level !== null && entry.certificates.length > 0)
    .sort((left, right) => Number(left.level) - Number(right.level));
}

function resolveSystemStargates(db: Db, systemId: number | null): Array<Record<string, unknown>> {
  if (systemId === null) return [];

  const rows = db.prepare(
    'SELECT stargate_id, destination_system_id, destination_stargate_id, data_json FROM sde_stargates WHERE system_id = ? ORDER BY stargate_id LIMIT 20'
  ).all(systemId) as Array<{
    stargate_id: number;
    destination_system_id: number | null;
    destination_stargate_id: number | null;
    data_json: string;
  }>;

  return rows.map((row) => {
    const destinationSystem = row.destination_system_id !== null
      ? resolveNamedEntity(db, 'system', row.destination_system_id)
      : null;
    const data = safeParse(row.data_json);
    return {
      stargate_id: row.stargate_id,
      destination_stargate_id: row.destination_stargate_id,
      destination_system: destinationSystem ? { id: destinationSystem.id, name: destinationSystem.name } : null,
      type_id: readNumeric(data, 'type_id'),
    };
  });
}

function resolveTypeSkins(db: Db, typeId: number): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT r.record_id, r.name, r.data_json
    FROM sde_raw_records r, json_each(r.data_json, '$.types')
    WHERE r.dataset_name = 'skins' AND json_each.value = ?
    ORDER BY r.record_id
    LIMIT 20
  `).all(typeId) as Array<{ record_id: string; name: string | null; data_json: string }>;

  return rows.map((row) => {
    const data = safeParse(row.data_json);
    const materialId = readNumeric(data, 'skin_material_id');
    const material = materialId !== null ? resolveRawRecord(db, 'skinMaterials', materialId) : null;
    return {
      id: row.record_id,
      name: row.name,
      material: material ? { id: material.id, name: material.name } : null,
    };
  });
}

function resolveTypePlanetSchematics(
  db: Db,
  typeId: number,
): { inputs: Array<Record<string, unknown>>; outputs: Array<Record<string, unknown>> } {
  const rows = db.prepare(`
    SELECT DISTINCT r.record_id, r.name, r.data_json
    FROM sde_raw_records r, json_each(r.data_json, '$.types')
    WHERE r.dataset_name = 'planetSchematics'
      AND json_extract(json_each.value, '$._key') = ?
    ORDER BY r.record_id
    LIMIT 30
  `).all(typeId) as Array<{ record_id: string; name: string | null; data_json: string }>;

  const inputs: Array<Record<string, unknown>> = [];
  const outputs: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const data = safeParse(row.data_json);
    const types = asRecordArray(data.types);
    const ownEntry = types.find((entry) => readNumeric(entry, '_key') === typeId);
    if (!ownEntry) continue;

    const item = {
      schematic_id: row.record_id,
      schematic_name: row.name,
      quantity: readNumeric(ownEntry, 'quantity'),
      cycle_time: readNumeric(data, 'cycle_time'),
    };
    if (readBoolean(ownEntry, 'is_input')) {
      inputs.push(item);
    } else {
      outputs.push(item);
    }
  }

  return { inputs, outputs };
}

function resolveSystemPlanets(db: Db, systemId: number | null): Array<Record<string, unknown>> {
  if (systemId === null) return [];

  const rows = db.prepare(`
    SELECT record_id, name, data_json
    FROM sde_raw_records
    WHERE dataset_name = 'mapPlanets'
      AND json_extract(data_json, '$.solarSystemID') = ?
    ORDER BY CAST(record_id AS INTEGER)
    LIMIT 20
  `).all(systemId) as Array<{ record_id: string; name: string | null; data_json: string }>;

  return rows.map((row) => {
    const data = safeParse(row.data_json);
    return {
      planet_id: row.record_id,
      celestial_index: readNumeric(data, 'celestial_index'),
      type: resolveTypeRef(db, readNumeric(data, 'type_id')),
      moons: asNumberArray(data.moonIDs).length,
      asteroid_belts: asNumberArray(data.asteroidBeltIDs).length,
      radius: readNumeric(data, 'radius'),
    };
  });
}

function resolveRawRecord(
  db: Db,
  dataset: string,
  id: number | string,
): { id: string; name: string | null; data: Record<string, unknown> } | null {
  const row = db.prepare(
    'SELECT record_id, name, data_json FROM sde_raw_records WHERE dataset_name = ? AND record_id = ?'
  ).get(dataset, String(id)) as { record_id: string; name: string | null; data_json: string } | undefined;
  if (!row) return null;
  return {
    id: row.record_id,
    name: row.name,
    data: safeParse(row.data_json),
  };
}

function normalizeBonus(entry: Record<string, unknown>): Record<string, unknown> {
  const text = localizeText(entry.bonusText);
  const unit = readNumeric(entry, 'unit_id');
  const normalized: Record<string, unknown> = {
    importance: readNumeric(entry, 'importance'),
  };
  if (text) {
    normalized.text = stripMarkup(text);
  }
  if (entry.bonus !== undefined) {
    normalized.bonus = entry.bonus;
  }
  if (unit !== null) {
    normalized.unit_id = unit;
  }
  return normalized;
}

function resolveTypeDogma(
  db: Db,
  typeId: number,
  detailed: boolean,
): { requiredSkills: Array<Record<string, unknown>>; attributes: Array<Record<string, unknown>>; effects: Array<Record<string, unknown>> } | null {
  const row = db.prepare('SELECT data_json FROM sde_type_dogma WHERE type_id = ?').get(typeId) as
    | { data_json: string }
    | undefined;
  if (!row) return null;

  const data = safeParse(row.data_json);
  const rawAttributes = asRecordArray(data.dogmaAttributes);
  const rawEffects = asRecordArray(data.dogmaEffects);

  const attributes = rawAttributes
    .map((entry) => enrichDogmaAttribute(db, entry))
    .filter((entry) => detailed || shouldKeepAttribute(entry));

  const attrByName = new Map<string, Record<string, unknown>>();
  for (const attr of attributes) {
    const name = typeof attr.name === 'string' ? attr.name : null;
    if (name) {
      attrByName.set(name, attr);
    }
  }

  const requiredSkills: Array<Record<string, unknown>> = [];
  for (const [name, attr] of attrByName.entries()) {
    const match = /^requiredSkill(\d+)$/.exec(name);
    if (!match) continue;

    const skillTypeId = readNumeric(attr, 'value');
    if (skillTypeId === null) continue;

    const skill = resolveTypeRef(db, skillTypeId);
    if (!skill) continue;

    const levelAttr = attrByName.get(`requiredSkill${match[1]}Level`);
    requiredSkills.push({
      slot: Number(match[1]),
      level: readNumeric(levelAttr ?? {}, 'value'),
      skill,
    });
  }

  const effects = rawEffects.map((entry) => {
    const effectId = readNumeric(entry, 'effect_id');
    const effect = effectId !== null ? resolveNamedEntity(db, 'dogma_effect', effectId) : null;
    return {
      effect_id: effectId,
      effect_name: effect?.name ?? null,
      is_default: readBoolean(entry, 'is_default'),
    };
  });

  return { requiredSkills, attributes, effects };
}

function enrichDogmaAttribute(db: Db, entry: Record<string, unknown>): Record<string, unknown> {
  const attributeId = readNumeric(entry, 'attribute_id');
  const meta = attributeId !== null ? resolveNamedEntity(db, 'dogma_attribute', attributeId) : null;
  const unitId = meta ? readNumeric(meta, 'unit_id') : null;
  const unit = unitId !== null ? resolveNamedEntity(db, 'dogma_unit', unitId) : null;

  return {
    attribute_id: attributeId,
    name: meta?.name ?? null,
    display_name: localizeText(meta?.displayName) ?? null,
    value: entry.value ?? null,
    unit: unit ? { id: unit.id, name: unit.name, display_name: localizeText(unit.displayName) ?? unit.name } : null,
    published: readBoolean(meta ?? {}, 'published'),
  };
}

function shouldKeepAttribute(attr: Record<string, unknown>): boolean {
  const name = typeof attr.name === 'string' ? attr.name : '';
  if (name.startsWith('requiredSkill')) return true;
  return readBoolean(attr, 'published') ?? false;
}

function resolveTypeRef(db: Db, typeId: number | null): Record<string, unknown> | null {
  if (typeId === null) return null;
  const type = resolveNamedEntity(db, 'type', typeId);
  if (!type) return null;
  const linkMeta = buildTypeLinkMeta(typeId, typeof type.name === 'string' ? type.name : null);
  return {
    id: type.id,
    name: type.name,
    links: linkMeta,
    telegram_commands: linkMeta.telegram_commands,
    ui_actions: {
      open_market_details: buildMarketDetailsAction(typeId),
    },
  };
}

function safeParse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function localizeText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const localized = value as Record<string, unknown>;
  const preferred = localized.ru ?? localized.en ?? localized['en-us'];
  if (typeof preferred === 'string') return preferred;
  for (const candidate of Object.values(localized)) {
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function stripMarkup(text: string): string {
  return text
    .replace(/<a [^>]*>/gi, '')
    .replace(/<\/a>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readField(obj: Record<string, unknown>, snakeCase: string): unknown {
  if (snakeCase in obj) return obj[snakeCase];

  const camel = snakeCase.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camel in obj) return obj[camel];

  const camelId = camel.replace(/Id$/, 'ID');
  if (camelId in obj) return obj[camelId];

  return undefined;
}

function readNumeric(obj: Record<string, unknown>, snakeCase: string): number | null {
  const value = readField(obj, snakeCase);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function readBoolean(obj: Record<string, unknown>, snakeCase: string): boolean | null {
  const value = readField(obj, snakeCase);
  if (typeof value === 'boolean') return value;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : null))
    .filter((item): item is number => item !== null);
}
