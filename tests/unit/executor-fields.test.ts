import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filterEsiFields, ESI_FIELD_WHITELIST, validateEsiFields } from '../../src/agent/executor.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('offline');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('filterEsiFields', () => {
  const sampleOrder = {
    order_id: 123,
    type_id: 587,
    price: 1000.5,
    volume_remain: 50,
    volume_total: 100,
    is_buy_order: false,
    location_id: 60003760,
    system_id: 30000142,
    duration: 90,
    min_volume: 1,
    range: 'region',
    issued: '2025-01-01T00:00:00Z',
  };

  it('applies default whitelist for known operation', () => {
    const result = filterEsiFields('get_markets_region_id_orders', [sampleOrder]);
    expect(result).toEqual([{
      price: 1000.5,
      volume_remain: 50,
      is_buy_order: false,
      location_id: 60003760,
      system_id: 30000142,
    }]);
  });

  it('uses explicit requestedFields over default whitelist', () => {
    const result = filterEsiFields('get_markets_region_id_orders', [sampleOrder], ['price', 'volume_remain']);
    expect(result).toEqual([{
      price: 1000.5,
      volume_remain: 50,
    }]);
  });

  it('passes through data for unknown operation', () => {
    const data = [{ foo: 1, bar: 2 }];
    const result = filterEsiFields('get_some_unknown_endpoint', data);
    expect(result).toEqual(data);
  });

  it('passes through data when requestedFields is null', () => {
    const data = [{ foo: 1, bar: 2 }];
    const result = filterEsiFields('get_some_unknown_endpoint', data, null);
    expect(result).toEqual(data);
  });

  it('passes through non-noisy operations when fields is null', () => {
    const data = [{ moon_id: 1, name: 'Moon 1' }];
    const result = filterEsiFields('get_universe_moons_moon_id', data, null);
    expect(result).toEqual(data);
  });

  it('handles non-object items in array gracefully', () => {
    const result = filterEsiFields('get_markets_region_id_orders', [42, 'text', null]);
    expect(result).toEqual([42, 'text', null]);
  });

  it('handles single object (non-array) data', () => {
    const result = filterEsiFields('get_markets_region_id_orders', sampleOrder);
    expect(result).toEqual({
      price: 1000.5,
      volume_remain: 50,
      is_buy_order: false,
      location_id: 60003760,
      system_id: 30000142,
    });
  });

  it('filters character assets correctly', () => {
    const asset = {
      type_id: 587,
      location_id: 60003760,
      quantity: 10,
      item_id: 999,
      is_singleton: false,
      location_flag: 'Hangar',
      is_blueprint_copy: false,
    };
    const result = filterEsiFields('get_characters_character_id_assets', [asset]);
    expect(result).toEqual([{
      type_id: 587,
      location_id: 60003760,
      quantity: 10,
      item_id: 999,
      is_singleton: false,
    }]);
  });

  it('filters wallet journal correctly', () => {
    const entry = {
      id: 1,
      date: '2025-01-01',
      ref_type: 'market_transaction',
      amount: -500,
      balance: 1000000,
      description: 'test',
      first_party_id: 100,
      second_party_id: 200,
      tax: 10,
      tax_receiver_id: 300,
      reason: '',
      context_id: 999,
      context_id_type: 'market_transaction_id',
    };
    const result = filterEsiFields('get_characters_character_id_wallet_journal', [entry]);
    expect(result).toEqual([{
      date: '2025-01-01',
      ref_type: 'market_transaction',
      amount: -500,
      balance: 1000000,
      description: 'test',
      first_party_id: 100,
      second_party_id: 200,
    }]);
  });

  it('has whitelists for all documented endpoints', () => {
    const expectedEndpoints = [
      'get_markets_region_id_orders',
      'get_markets_structures_structure_id',
      'get_characters_character_id_assets',
      'get_characters_character_id_orders',
      'get_characters_character_id_orders_history',
      'get_characters_character_id_blueprints',
      'get_characters_character_id_industry_jobs',
      'get_characters_character_id_wallet_journal',
      'get_characters_character_id_wallet_transactions',
      'get_characters_character_id_contracts',
      'get_characters_character_id_skillqueue',
      'get_corporations_corporation_id_assets',
      'get_corporations_corporation_id_orders',
      'get_corporations_corporation_id_orders_history',
      'get_corporations_corporation_id_blueprints',
      'get_corporations_corporation_id_industry_jobs',
      'get_corporations_corporation_id_contracts',
      'get_corporations_corporation_id_wallets_division_journal',
      'get_corporations_corporation_id_wallets_division_transactions',
      'get_corporations_corporation_id_structures',
      'get_corporations_corporation_id_containers_logs',
      'get_contracts_public_region_id',
    ];
    for (const ep of expectedEndpoints) {
      expect(ESI_FIELD_WHITELIST[ep], `missing whitelist for ${ep}`).toBeDefined();
      expect(ESI_FIELD_WHITELIST[ep].length).toBeGreaterThan(0);
    }
  });

  it('ignores fields not present in the source object', () => {
    const partial = { price: 100 };
    const result = filterEsiFields('get_markets_region_id_orders', partial);
    expect(result).toEqual({ price: 100 });
  });

  it('rejects empty requested fields', async () => {
    await expect(validateEsiFields('get_markets_region_id_orders', [])).resolves.toEqual({
      ok: false,
      error: 'Invalid fields: expected at least one field name.',
    });
  });

  it('rejects non-string requested fields', async () => {
    await expect(validateEsiFields('get_markets_region_id_orders', ['price', 123])).resolves.toEqual({
      ok: false,
      error: 'Invalid fields: every entry must be a string.',
    });
  });

  it('rejects unknown requested fields for the operation', async () => {
    const result = await validateEsiFields('get_markets_region_id_orders', ['price', 'unknown_field']);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected validation to fail');
    }
    expect(result.error).toContain('Invalid fields for get_markets_region_id_orders: unknown_field');
  });

  it('accepts explicit requested fields for supported operation', async () => {
    await expect(validateEsiFields('get_markets_region_id_orders', ['price', 'volume_remain'])).resolves.toEqual({
      ok: true,
      fields: ['price', 'volume_remain'],
    });
  });

  it('rejects field projection for scalar-array operations', async () => {
    await expect(validateEsiFields('get_markets_region_id_types', ['type_id'])).resolves.toEqual({
      ok: false,
      error: 'Operation get_markets_region_id_types does not support field projection.',
    });
  });

  it('keeps whitelist operation ids in sync with the cached ESI catalog', async () => {
    const { loadEsiCatalog } = await import('../../src/eve/esi-catalog.js');
    const catalog = await loadEsiCatalog();
    for (const operationName of Object.keys(ESI_FIELD_WHITELIST)) {
      expect(catalog.has(operationName), `unknown catalog op ${operationName}`).toBe(true);
    }
  });
});
