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
  it('exports exactly the frozen five-name allowlist and one schema per name', () => {
    expect([...PROGRAMMATIC_TOOL_ALLOWLIST]).toEqual([
      'count_universe_objects',
      'batch_market_prices',
      'compare_wormhole_types',
      'scout_systems',
      'kill_activity_summary',
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
  ] as Array<[ProgrammaticToolName, unknown]>)('accepts the fixed %s error arm', (name, output) => {
    expect(validateProgrammaticToolOutput(name, output).valid).toBe(true);
  });

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
  };
}
