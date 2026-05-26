import { loadEsiCatalog } from '../eve/esi-catalog.js';

/**
 * Default whitelist of fields to keep per ESI operation.
 * If an operation is listed here, only these fields survive.
 * Unlisted operations pass through unfiltered.
 */
export const ESI_FIELD_WHITELIST: Record<string, string[]> = {
  // Market
  get_markets_region_id_orders: ['price', 'volume_remain', 'is_buy_order', 'location_id', 'system_id'],
  get_markets_structures_structure_id: ['price', 'volume_remain', 'is_buy_order', 'location_id'],

  // Character
  get_characters_character_id_assets: ['type_id', 'location_id', 'quantity', 'item_id', 'is_singleton'],
  get_characters_character_id_orders: ['type_id', 'price', 'volume_remain', 'is_buy_order', 'location_id', 'region_id', 'volume_total'],
  get_characters_character_id_orders_history: ['type_id', 'price', 'volume_remain', 'is_buy_order', 'location_id', 'region_id', 'state'],
  get_characters_character_id_blueprints: ['type_id', 'quantity', 'material_efficiency', 'time_efficiency', 'runs', 'location_id', 'item_id'],
  get_characters_character_id_industry_jobs: ['activity_id', 'blueprint_type_id', 'product_type_id', 'status', 'start_date', 'end_date', 'runs', 'output_location_id'],
  get_characters_character_id_wallet_journal: ['date', 'ref_type', 'amount', 'balance', 'description', 'first_party_id', 'second_party_id'],
  get_characters_character_id_wallet_transactions: ['date', 'type_id', 'quantity', 'unit_price', 'is_buy', 'location_id', 'client_id'],
  get_characters_character_id_contracts: ['contract_id', 'type', 'status', 'price', 'date_issued', 'date_expired', 'issuer_id', 'start_location_id', 'end_location_id', 'title', 'volume'],
  get_characters_character_id_skillqueue: ['skill_id', 'finished_level', 'finish_date', 'queue_position'],

  // Corporation
  get_corporations_corporation_id_assets: ['type_id', 'location_id', 'quantity', 'item_id', 'is_singleton'],
  get_corporations_corporation_id_orders: ['type_id', 'price', 'volume_remain', 'is_buy_order', 'location_id', 'region_id'],
  get_corporations_corporation_id_orders_history: ['type_id', 'price', 'volume_remain', 'is_buy_order', 'location_id', 'region_id', 'state'],
  get_corporations_corporation_id_blueprints: ['type_id', 'quantity', 'material_efficiency', 'time_efficiency', 'runs', 'location_id'],
  get_corporations_corporation_id_industry_jobs: ['activity_id', 'blueprint_type_id', 'product_type_id', 'status', 'start_date', 'end_date', 'runs'],
  get_corporations_corporation_id_contracts: ['contract_id', 'type', 'status', 'price', 'date_issued', 'date_expired', 'issuer_id', 'start_location_id', 'end_location_id', 'title', 'volume'],
  get_corporations_corporation_id_wallets_division_journal: ['date', 'ref_type', 'amount', 'balance', 'description', 'first_party_id', 'second_party_id'],
  get_corporations_corporation_id_wallets_division_transactions: ['date', 'type_id', 'quantity', 'unit_price', 'is_buy', 'location_id', 'client_id'],
  get_corporations_corporation_id_structures: ['structure_id', 'name', 'system_id', 'type_id', 'state', 'fuel_expires', 'services'],
  get_corporations_corporation_id_containers_logs: ['action', 'character_id', 'container_type_id', 'location_id', 'logged_at', 'quantity', 'type_id'],

  // Public contracts
  get_contracts_public_region_id: ['contract_id', 'type', 'price', 'date_expired', 'date_issued', 'start_location_id', 'end_location_id', 'title', 'volume'],

  // Bulk endpoints (server-side row filtering via filter_ids)
  get_universe_system_kills: ['system_id', 'ship_kills', 'npc_kills', 'pod_kills'],
  get_universe_system_jumps: ['system_id', 'ship_jumps'],
  get_markets_prices: ['type_id', 'adjusted_price', 'average_price'],
  get_industry_systems: ['solar_system_id', 'cost_indices'],
  get_sovereignty_map: ['system_id', 'alliance_id', 'corporation_id', 'faction_id'],
};

/**
 * Filter ESI response data to only keep relevant fields.
 * - If `requestedFields` is provided (from tool args.fields), use those.
 * - Otherwise fall back to ESI_FIELD_WHITELIST default for the operation.
 * - If neither exists, return data as-is.
 */
export function filterEsiFields(
  operationName: string,
  data: unknown,
  requestedFields?: string[] | null,
): unknown {
  const fields = requestedFields ?? ESI_FIELD_WHITELIST[operationName] ?? null;
  if (!fields) return data;

  const fieldSet = new Set(fields);

  if (Array.isArray(data)) {
    return data.map((item) => pickFields(item, fieldSet));
  }

  return pickFields(data, fieldSet);
}

export async function validateEsiFields(
  operationName: string,
  rawFields: unknown,
): Promise<{ ok: true; fields: string[] | null } | { ok: false; error: string }> {
  if (rawFields === undefined || rawFields === null) {
    return { ok: true, fields: null };
  }
  if (!Array.isArray(rawFields)) {
    return { ok: false, error: 'Invalid fields: expected an array of field names or null.' };
  }
  if (rawFields.some((field) => typeof field !== 'string')) {
    return { ok: false, error: 'Invalid fields: every entry must be a string.' };
  }

  const fields = [...new Set(rawFields as string[])];
  if (fields.length === 0) {
    return { ok: false, error: 'Invalid fields: expected at least one field name.' };
  }

  const catalog = await loadEsiCatalog();
  const operation = catalog.get(operationName);
  const allowedFields = operation?.responseFields ?? null;
  if (!allowedFields || allowedFields.length === 0) {
    return { ok: false, error: `Operation ${operationName} does not support field projection.` };
  }

  const allowedFieldSet = new Set(allowedFields);
  const invalidFields = fields.filter((field) => !allowedFieldSet.has(field));
  if (invalidFields.length > 0) {
    return {
      ok: false,
      error: `Invalid fields for ${operationName}: ${invalidFields.join(', ')}. Allowed fields: ${allowedFields.join(', ')}`,
    };
  }

  return { ok: true, fields };
}

function pickFields(item: unknown, fields: Set<string>): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const record = item as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in record) {
      result[key] = record[key];
    }
  }
  return result;
}
