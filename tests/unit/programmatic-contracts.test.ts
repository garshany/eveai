import { describe, expect, it } from 'vitest';
import {
  MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS,
  PROGRAMMATIC_OUTPUT_SCHEMAS,
  PROGRAMMATIC_TOOL_ALLOWLIST,
  PROGRAMMATIC_TOOL_NAMES,
  serializeProgrammaticToolOutput,
  validateJsonSchema,
  validateProgrammaticToolOutput,
  type ProgrammaticToolName,
} from '../../src/agent/programmatic-contracts.js';

const now = '2026-07-14T12:00:00.000Z';

describe('programmatic contracts', () => {
  it('exports exactly the frozen nine-name allowlist and one schema per name', () => {
    expect([...PROGRAMMATIC_TOOL_ALLOWLIST]).toEqual([
      'count_universe_objects',
      'batch_market_prices',
      'compare_wormhole_types',
      'scout_systems',
      'kill_activity_summary',
      'market_history_summary',
      'system_metric_snapshot',
      'doctrine_summary',
      'dynamic_item_summary',
    ]);
    expect(Object.keys(PROGRAMMATIC_OUTPUT_SCHEMAS)).toEqual(PROGRAMMATIC_TOOL_NAMES);
  });

  it.each(Object.entries(validOutputs()) as Array<[ProgrammaticToolName, unknown]>) (
    'accepts and serializes the fixed %s success output',
    (name, output) => {
      expect(validateProgrammaticToolOutput(name, output)).toEqual({ valid: true, errors: [] });
      expect(JSON.parse(serializeProgrammaticToolOutput(name, output))).toEqual(output);
    },
  );

  it.each([
    ['count_universe_objects', { ok: false, error: 'Invalid arguments', blocked: true }],
    ['batch_market_prices', facadeError('CCP ESI', true)],
    ['compare_wormhole_types', facadeError('EVE-Scout', false)],
    ['scout_systems', facadeError('EVE-Scout', false)],
    ['kill_activity_summary', facadeError('EVE-KILL', false)],
    ['market_history_summary', facadeError('CCP ESI', true)],
    ['system_metric_snapshot', facadeError('CCP ESI', true)],
    ['doctrine_summary', facadeError('EVE-KILL MCP', false)],
    ['dynamic_item_summary', facadeError('CCP ESI', true)],
  ] as Array<[ProgrammaticToolName, unknown]>)('accepts the fixed %s error arm', (name, output) => {
    expect(validateProgrammaticToolOutput(name, output).valid).toBe(true);
  });

  it.each(['market_history_summary', 'system_metric_snapshot', 'doctrine_summary', 'dynamic_item_summary'] as ProgrammaticToolName[])(
    'rejects non-HTTP error status values for %s',
    (name) => {
      const source = name === 'doctrine_summary' ? 'EVE-KILL MCP' : 'CCP ESI';
      const authoritative = name !== 'doctrine_summary';
      expect(validateProgrammaticToolOutput(name, {
        ...facadeError(source, authoritative),
        status: 99,
      }).valid).toBe(false);
      expect(validateProgrammaticToolOutput(name, {
        ...facadeError(source, authoritative),
        status: 600,
      }).valid).toBe(false);
      expect(validateProgrammaticToolOutput(name, {
        ...facadeError(source, authoritative),
        status: 503,
      }).valid).toBe(true);
    },
  );

  it('validates the schema keywords used by the registry', () => {
    const schema = {
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'sample' },
            state: { type: 'string', enum: ['ready'] },
            code: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[A-Z]+$' },
            time: { type: ['string', 'null'], format: 'date-time' },
            score: { type: 'number', minimum: 0, maximum: 10 },
            ids: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              uniqueItems: true,
              items: { type: 'integer', minimum: 1 },
            },
          },
          required: ['kind', 'state', 'code', 'time', 'score', 'ids'],
          additionalProperties: false,
        },
      ],
    };
    expect(validateJsonSchema(schema, {
      kind: 'sample',
      state: 'ready',
      code: 'AB',
      time: now,
      score: 10,
      ids: [1, 2],
    }).valid).toBe(true);
    expect(validateJsonSchema(schema, {
      kind: 'sample',
      state: 'wrong',
      code: 'a',
      time: 'yesterday',
      score: 11,
      ids: [1, 1, 2],
      extra: true,
    }).valid).toBe(false);
  });

  it.each(PROGRAMMATIC_TOOL_NAMES)(
    'replaces invalid %s output with its schema-valid bounded error arm',
    (name) => {
      const serialized = serializeProgrammaticToolOutput(name, {
        ok: true,
        leaked_upstream_body: 'do not return this',
      });
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(serialized.length).toBeLessThanOrEqual(MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS);
      expect(validateProgrammaticToolOutput(name, parsed).valid).toBe(true);
      expect(parsed).not.toHaveProperty('leaked_upstream_body');
      expect(parsed).toMatchObject({ ok: false, blocked: false });
    },
  );

  it.each(PROGRAMMATIC_TOOL_NAMES)(
    'replaces oversized %s output wholesale without character slicing',
    (name) => {
      const serialized = serializeProgrammaticToolOutput(name, {
        ...validOutputs()[name] as Record<string, unknown>,
        oversized: 'secret-marker'.repeat(MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS),
      });
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(serialized.length).toBeLessThanOrEqual(MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS);
      expect(validateProgrammaticToolOutput(name, parsed).valid).toBe(true);
      expect(serialized).not.toContain('secret-marker');
      expect(parsed).toMatchObject({
        ok: false,
        blocked: false,
        error: 'Tool output exceeded the local size limit.',
      });
    },
  );

  it('replaces non-JSON values with a schema-valid serialization error', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const serialized = serializeProgrammaticToolOutput('batch_market_prices', circular);
    expect(JSON.parse(serialized)).toMatchObject({
      ok: false,
      source: 'CCP ESI',
      authoritative: true,
      status: null,
      blocked: false,
      error: 'Tool output could not be serialized safely.',
    });
  });

  it('rejects omitted fields, unknown fields, bad constants, and invalid nested values', () => {
    const output = validOutputs().scout_systems;
    expect(validateProgrammaticToolOutput('scout_systems', {
      ...output,
      count: 26,
    }).valid).toBe(false);
    expect(validateProgrammaticToolOutput('scout_systems', {
      ...output,
      source: 'CCP ESI',
    }).valid).toBe(false);
    const { systems: _systems, ...missingSystems } = output;
    expect(validateProgrammaticToolOutput('scout_systems', missingSystems).valid).toBe(false);
    expect(validateProgrammaticToolOutput('scout_systems', {
      ...output,
      private_token: 'forbidden',
    }).valid).toBe(false);
  });
});

function facadeError(source: string, authoritative: boolean): Record<string, unknown> {
  return {
    ok: false,
    source,
    authoritative,
    error: 'Public source unavailable.',
    status: null,
    blocked: false,
  };
}

function validOutputs(): Record<ProgrammaticToolName, Record<string, unknown>> {
  return {
    count_universe_objects: {
      ok: true,
      target_kind: 'region',
      target_name: 'The Forge',
      object_kind: 'systems',
      count: 779,
      region_id: 10_000_002,
    },
    batch_market_prices: {
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: { retrieved_at: now, data_through: null, cache_max_age_seconds: null },
      region_id: 10_000_002,
      prices: [{
        type_id: 34,
        sell: { min_price: 5.5, volume: 10, orders: 2 },
        buy: null,
        global_average_price: null,
        error: null,
      }],
    },
    compare_wormhole_types: {
      ok: true,
      source: 'EVE-Scout',
      authoritative: false,
      limitation: 'Third-party public EVE-Scout data; entries may be stale or incomplete.',
      freshness: { retrieved_at: now, data_through: null, cache_max_age_seconds: 86_400 },
      wormhole_types: [
        {
          identifier: 'A009',
          found: true,
          type_id: 30_770,
          max_jump_mass: 5_000_000,
          max_stable_mass: 500_000_000,
          lifetime_minutes: 960,
          mass_regeneration: 0,
          source_classes: ['C1'],
          target_class: 'C2',
          possible_static: true,
          wandering_only: false,
        },
        {
          identifier: 'B274',
          found: false,
          type_id: null,
          max_jump_mass: null,
          max_stable_mass: null,
          lifetime_minutes: null,
          mass_regeneration: null,
          source_classes: [],
          target_class: null,
          possible_static: null,
          wandering_only: null,
        },
      ],
    },
    scout_systems: {
      ok: true,
      source: 'EVE-Scout',
      authoritative: false,
      limitation: 'Third-party public EVE-Scout classification; results may be stale or incomplete.',
      freshness: { retrieved_at: now, data_through: null, cache_max_age_seconds: 86_400 },
      query: 'Jita',
      space: 'hs',
      count: 1,
      systems: [{
        system_id: 30_000_142,
        system_name: 'Jita',
        system_class: 'High-Sec',
        security_status: 0.9,
        region_id: 10_000_002,
        region_name: 'The Forge',
        jove_observatory: false,
      }],
    },
    kill_activity_summary: {
      ok: true,
      source: 'EVE-KILL',
      authoritative: false,
      limitation: 'Third-party public killboard observation; coverage may be incomplete.',
      freshness: { retrieved_at: now, data_through: now, cache_max_age_seconds: null },
      scope: 'system',
      id: 30_000_142,
      activity: 'all',
      window: { from: '2026-07-13T12:00:00.000Z', to: now },
      coverage: { observed: 1, truncated: false },
      aggregates: {
        kills: 1,
        losses: 0,
        dual_role: 0,
        npc: 0,
        solo: 1,
        valued: 1,
        total_value_isk: 1_000_000,
        first_killmail_time: now,
        last_killmail_time: now,
      },
      evidence_killmail_ids: [123],
    },
    market_history_summary: {
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: { retrieved_at: now, data_through: now, cache_max_age_seconds: null },
      region_id: 10_000_002,
      type_id: 34,
      requested_days: 30,
      window: { first_date: '2026-07-13', last_date: '2026-07-14' },
      observed_days: 2,
      price: {
        lowest: 4.5,
        highest: 6,
        mean_daily_average: 5.25,
        volume_weighted_average: 5.3,
        change_percent: 10,
      },
      volume: { total: 200, mean_per_observed_day: 100 },
      volatility: { daily_return_stddev_percent: 0 },
      liquidity: { total_orders: 20, mean_orders_per_observed_day: 10, active_days: 2 },
    },
    system_metric_snapshot: {
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: { retrieved_at: now, data_through: null, cache_max_age_seconds: 3600 },
      metric: 'kills',
      count: 1,
      rows: [{ system_id: 30_000_142, found: true, ship: 4, npc: 12, pod: 1 }],
    },
    doctrine_summary: {
      ok: true,
      source: 'EVE-KILL MCP',
      authoritative: false,
      limitation: 'Third-party public loss-fit inference; coverage and doctrine classifications may be incomplete.',
      freshness: { retrieved_at: now, data_through: now, cache_max_age_seconds: null },
      entity: { id: 99_000_001, type: 'alliance', name: 'Example Alliance' },
      window: { from: '2026-07-01T00:00:00.000Z', to: now },
      count: 1,
      doctrines: [{
        family_id: 'a'.repeat(64),
        signature: 'Raven / Cruise / Shield Buffer',
        ship_type_id: 638,
        ship_name: 'Raven',
        losses: 12,
        isk_lost: 1_000_000_000,
        average_isk_per_loss: 83_333_333.333333,
        first_loss: '2026-07-02T00:00:00.000Z',
        last_loss: now,
        evidence_killmail_id: 123,
      }],
    },
    dynamic_item_summary: {
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: { retrieved_at: now, data_through: null, cache_max_age_seconds: null },
      type_id: 49_726,
      item_id: 1_000_000_001,
      source_type_id: 33_103,
      mutator_type_id: 47_845,
      attributes: [{
        attribute_id: 9,
        found: true,
        value: 350,
        base_value: 300,
        delta: 50,
        delta_percent: 16.666667,
      }],
    },
  };
}
