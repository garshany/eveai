import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateProgrammaticToolOutput } from '../../src/agent/programmatic-contracts.js';

const mocks = vi.hoisted(() => ({ callEsiOperation: vi.fn() }));
vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: mocks.callEsiOperation }));

import {
  DYNAMIC_ITEM_SUMMARY_TOOL,
  executeDynamicItemSummary,
  isDynamicItemSummaryTool,
  validateDynamicItemSummaryArgs,
} from '../../src/eve/dynamic-item-summary.js';

let db: Database.Database;
const args = { type_id: 47740, item_id: 123456789, attribute_ids: [10, 20, 30] };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE sde_type_dogma (type_id INTEGER PRIMARY KEY, data_json TEXT NOT NULL)');
  db.prepare('INSERT INTO sde_type_dogma (type_id, data_json) VALUES (?, ?)').run(500, JSON.stringify({
    dogmaAttributes: [
      { attributeID: 10, value: 100 },
      { attributeID: 20, value: 0 },
      { attributeID: 30, value: 999 },
    ],
  }));
  mocks.callEsiOperation.mockReset();
});

afterEach(() => db.close());

describe('dynamic_item_summary facade', () => {
  it('declares the strict tool and enforces direct/programmatic limits and uniqueness before egress', async () => {
    expect(DYNAMIC_ITEM_SUMMARY_TOOL).toMatchObject({
      name: 'dynamic_item_summary', strict: true,
      parameters: { required: ['type_id', 'item_id', 'attribute_ids'], additionalProperties: false },
    });
    expect(DYNAMIC_ITEM_SUMMARY_TOOL.defer_loading).toBeUndefined();
    expect(isDynamicItemSummaryTool('dynamic_item_summary')).toBe(true);
    const eleven = Array.from({ length: 11 }, (_, index) => index + 1);
    expect(validateDynamicItemSummaryArgs({ ...args, attribute_ids: eleven })).toMatchObject({ ok: true });
    expect(validateDynamicItemSummaryArgs({ ...args, attribute_ids: eleven }, { programmatic: true })).toMatchObject({
      ok: false, error: { blocked: true },
    });
    for (const invalid of [
      { ...args, type_id: 0 },
      { ...args, item_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...args, attribute_ids: [] },
      { ...args, attribute_ids: [10, 10] },
      { ...args, private_token: 'secret' },
    ]) {
      expect(await executeDynamicItemSummary(db, invalid)).toMatchObject({ ok: false, blocked: true });
    }
    expect(mocks.callEsiOperation).not.toHaveBeenCalled();
  });

  it('projects only requested attributes in order with rounded local base/delta evidence', async () => {
    mocks.callEsiOperation.mockResolvedValue(success({
      created_by: 987654321,
      source_type_id: 500,
      mutator_type_id: 600,
      dogma_attributes: [
        { attribute_id: 20, value: 25 },
        { attribute_id: 999, value: 777 },
        { attribute_id: 10, value: 125.123456789 },
      ],
      dogma_effects: [{ effect_id: 42, is_default: true }],
    }));
    const result = await executeDynamicItemSummary(db, args);

    expect(mocks.callEsiOperation).toHaveBeenCalledWith(
      db,
      'get_dogma_dynamic_items_type_id_item_id',
      { type_id: args.type_id, item_id: args.item_id },
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: { data_through: '2026-07-15T12:00:00.000Z', cache_max_age_seconds: 3600 },
      type_id: args.type_id,
      item_id: args.item_id,
      source_type_id: 500,
      mutator_type_id: 600,
      attributes: [
        {
          attribute_id: 10, found: true, value: 125.123457, base_value: 100,
          delta: 25.123457, delta_percent: 25.123457,
        },
        {
          attribute_id: 20, found: true, value: 25, base_value: 0,
          delta: 25, delta_percent: null,
        },
        {
          attribute_id: 30, found: false, value: null, base_value: null,
          delta: null, delta_percent: null,
        },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of ['created_by', '987654321', 'dogma_effects', 'effect_id', '999', '777']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(validateProgrammaticToolOutput('dynamic_item_summary', result)).toEqual({ valid: true, errors: [] });
  });

  it('keeps found values when SDE base data is absent or malformed', async () => {
    mocks.callEsiOperation.mockResolvedValue(success({
      source_type_id: 501,
      mutator_type_id: 600,
      dogma_attributes: [{ attribute_id: 10, value: -5 }],
      dogma_effects: [],
    }));
    expect(await executeDynamicItemSummary(db, { ...args, attribute_ids: [10] })).toMatchObject({
      ok: true,
      attributes: [{ attribute_id: 10, found: true, value: -5, base_value: null, delta: null, delta_percent: null }],
    });
  });

  it('fails closed on conflicting attributes, malformed effects, unsafe creator identity, or non-finite values', async () => {
    const cases = [
      {
        source_type_id: 500, mutator_type_id: 600, dogma_effects: [],
        dogma_attributes: [{ attribute_id: 10, value: 1 }, { attribute_id: 10, value: 2 }],
      },
      {
        source_type_id: 500, mutator_type_id: 600, dogma_attributes: [],
        dogma_effects: [{ effect_id: 1, is_default: 'yes' }],
      },
      {
        created_by: Number.MAX_SAFE_INTEGER + 1,
        source_type_id: 500, mutator_type_id: 600, dogma_attributes: [], dogma_effects: [],
      },
      {
        source_type_id: 500, mutator_type_id: 600, dogma_effects: [],
        dogma_attributes: [{ attribute_id: 10, value: Number.POSITIVE_INFINITY }],
      },
    ];
    for (const data of cases) {
      mocks.callEsiOperation.mockResolvedValue(success(data));
      expect(await executeDynamicItemSummary(db, args)).toEqual({
        ok: false, source: 'CCP ESI', authoritative: true,
        error: 'CCP ESI returned an invalid dynamic item response.', status: null, blocked: false,
      });
    }
  });

  it('rejects dogma attribute or effect arrays larger than 1000 entries', async () => {
    const oversized = [
      {
        source_type_id: 500,
        mutator_type_id: 600,
        dogma_attributes: Array.from({ length: 1_001 }, (_, index) => ({ attribute_id: index + 1, value: 1 })),
        dogma_effects: [],
      },
      {
        source_type_id: 500,
        mutator_type_id: 600,
        dogma_attributes: [],
        dogma_effects: Array.from({ length: 1_001 }, (_, index) => ({ effect_id: index + 1, is_default: false })),
      },
    ];
    for (const data of oversized) {
      mocks.callEsiOperation.mockResolvedValue(success(data));
      expect(await executeDynamicItemSummary(db, args)).toMatchObject({
        ok: false,
        error: 'CCP ESI returned an invalid dynamic item response.',
        blocked: false,
      });
    }
  });

  it('sanitizes upstream failures without reflecting transport data', async () => {
    mocks.callEsiOperation.mockResolvedValue({ ok: false, status: 404, error: 'raw creator secret' });
    const result = await executeDynamicItemSummary(db, args);
    expect(result).toEqual({
      ok: false, source: 'CCP ESI', authoritative: true,
      error: 'CCP ESI dynamic item request failed with HTTP status 404.', status: 404, blocked: false,
    });
    expect(JSON.stringify(result)).not.toContain('creator secret');
  });
});

function success(data: unknown) {
  return {
    ok: true,
    status: 200,
    cached: false,
    headers: { 'cache-control': 'max-age=3600', 'last-modified': 'Wed, 15 Jul 2026 12:00:00 GMT' },
    data,
  };
}
