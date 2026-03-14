import type { Db } from '../db/sqlite.js';

export type SdeEntity =
  | 'type' | 'group' | 'category' | 'market_group'
  | 'dogma_attribute' | 'dogma_effect'
  | 'region' | 'constellation' | 'system' | 'station'
  | 'blueprint';

export type LookupMode = 'by_id' | 'by_name' | 'search';

export interface SdeRequest {
  entity: SdeEntity;
  lookup_mode: LookupMode;
  value: string;
  limit: number;
}

export interface SdeResult {
  ok: boolean;
  count: number;
  items: Record<string, unknown>[];
  error: string | null;
}

const TABLE_MAP: Record<SdeEntity, { table: string; idCol: string; nameCol: string }> = {
  type:             { table: 'sde_types',             idCol: 'type_id',           nameCol: 'name' },
  group:            { table: 'sde_groups',            idCol: 'group_id',          nameCol: 'name' },
  category:         { table: 'sde_categories',        idCol: 'category_id',       nameCol: 'name' },
  market_group:     { table: 'sde_market_groups',     idCol: 'market_group_id',   nameCol: 'name' },
  dogma_attribute:  { table: 'sde_dogma_attributes',  idCol: 'attribute_id',      nameCol: 'name' },
  dogma_effect:     { table: 'sde_dogma_effects',     idCol: 'effect_id',         nameCol: 'name' },
  region:           { table: 'sde_regions',           idCol: 'region_id',         nameCol: 'name' },
  constellation:    { table: 'sde_constellations',    idCol: 'constellation_id',  nameCol: 'name' },
  system:           { table: 'sde_systems',           idCol: 'system_id',         nameCol: 'name' },
  station:          { table: 'sde_stations',          idCol: 'station_id',        nameCol: 'name' },
  blueprint:        { table: 'sde_blueprints',        idCol: 'blueprint_type_id', nameCol: 'name' },
};

/**
 * Tool handler for query_sde.
 */
export function querySde(db: Db, req: SdeRequest): SdeResult {
  const mapping = TABLE_MAP[req.entity];
  if (!mapping) {
    return { ok: false, count: 0, items: [], error: `Unknown entity: ${req.entity}` };
  }

  const limit = Math.min(Math.max(req.limit, 1), 50);

  try {
    let rows: unknown[];

    switch (req.lookup_mode) {
      case 'by_id': {
        const id = Number(req.value);
        if (isNaN(id)) {
          return { ok: false, count: 0, items: [], error: 'by_id requires a numeric value' };
        }
        rows = db.prepare(
          `SELECT ${mapping.idCol} AS id, ${mapping.nameCol} AS name, data_json FROM ${mapping.table} WHERE ${mapping.idCol} = ?`
        ).all(id);
        break;
      }

      case 'by_name': {
        rows = db.prepare(
          `SELECT ${mapping.idCol} AS id, ${mapping.nameCol} AS name, data_json FROM ${mapping.table} WHERE ${mapping.nameCol} = ? COLLATE NOCASE LIMIT ?`
        ).all(req.value, limit);
        break;
      }

      case 'search': {
        rows = db.prepare(
          `SELECT ${mapping.idCol} AS id, ${mapping.nameCol} AS name, data_json FROM ${mapping.table} WHERE ${mapping.nameCol} LIKE ? COLLATE NOCASE LIMIT ?`
        ).all(`%${req.value}%`, limit);
        break;
      }
    }

    const items = (rows as { id: number; name: string; data_json: string }[]).map((row) => ({
      id: row.id,
      name: row.name,
      ...JSON.parse(row.data_json),
    }));

    return { ok: true, count: items.length, items, error: null };
  } catch (err) {
    return { ok: false, count: 0, items: [], error: `SDE query error: ${(err as Error).message}` };
  }
}
