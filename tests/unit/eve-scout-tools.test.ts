import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  getRoute: vi.fn(),
  getMultiRoute: vi.fn(),
  getClosestHighsec: vi.fn(),
  getJoveRoutes: vi.fn(),
  getSignatureRoutes: vi.fn(),
  getSignatures: vi.fn(),
  getObservations: vi.fn(),
  getWormholeTypes: vi.fn(),
  searchSystems: vi.fn(),
}));

vi.mock('../../src/eve/eve-scout-client.js', () => client);

import {
  executeEveScoutTool,
  validateCompareWormholeTypesArgs,
  validateScoutSystemsArgs,
} from '../../src/eve/eve-scout-executor.js';
import { buildEveScoutNamespace, COMPARE_WORMHOLE_TYPES_TOOL } from '../../src/eve/eve-scout-tools.js';

const FRESHNESS = { dataThrough: '2026-07-14T12:00:00.000Z', cacheMaxAgeSeconds: 86400, cacheHit: false };
const C140 = {
  identifier: 'C140',
  type_id: 30705,
  max_jump_mass: 2_000_000_000,
  max_stable_mass: 3_300_000_000,
  max_stable_time: 1440,
  mass_regeneration: 0,
  source: ['c5', 'c6'],
  target_system_class: 'ls',
  possible_static: false,
  wandering_only: true,
  comment_public: 'must not escape the bounded facade',
  signature_level: [1],
};

describe('EVE-Scout bounded tool facades', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports the comparison descriptor without changing the broad direct tool', () => {
    expect(COMPARE_WORMHOLE_TYPES_TOOL).toMatchObject({
      name: 'compare_wormhole_types',
      parameters: {
        properties: { identifiers: { minItems: 2, maxItems: 8 } },
        required: ['identifiers'],
        additionalProperties: false,
      },
    });
    expect(COMPARE_WORMHOLE_TYPES_TOOL.parameters.properties).toMatchObject({
      identifiers: expect.not.objectContaining({ uniqueItems: true }),
    });
    const namespace = buildEveScoutNamespace();
    expect(namespace.tools.map((tool) => tool.name)).toContain('compare_wormhole_types');
    const broad = namespace.tools.find((tool) => tool.name === 'scout_wormhole_types');
    expect(broad).not.toHaveProperty('allowed_callers');
    expect(broad).not.toHaveProperty('output_schema');
  });

  it('normalizes exact identifiers and returns ordered explicit not-found rows', async () => {
    client.getWormholeTypes.mockResolvedValue({ ok: true, data: [C140], freshness: FRESHNESS });

    const result = await executeEveScoutTool({} as never, 'compare_wormhole_types', {
      identifiers: [' c140 ', 'A239'],
    });

    expect(client.getWormholeTypes).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      source: 'EVE-Scout',
      authoritative: false,
      freshness: { data_through: FRESHNESS.dataThrough, cache_max_age_seconds: 86400 },
      wormhole_types: [
        {
          identifier: 'C140',
          found: true,
          type_id: 30705,
          source_classes: ['c5', 'c6'],
        },
        {
          identifier: 'A239',
          found: false,
          type_id: null,
          source_classes: [],
          target_class: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('must not escape');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(12_000);
  });

  it('rejects malformed or case-insensitively duplicate identifiers before egress', async () => {
    expect(validateCompareWormholeTypesArgs({ identifiers: ['C140', ' c140 '] })).toEqual({
      ok: false,
      error: 'identifiers must be unique',
    });
    const result = await executeEveScoutTool({} as never, 'compare_wormhole_types', {
      identifiers: ['C140', 'bad'],
      source: 'c5',
    });
    expect(result).toMatchObject({ ok: false, source: 'EVE-Scout', status: null, blocked: false });
    expect(client.getWormholeTypes).not.toHaveBeenCalled();
  });

  it('maps exact classes to coarse upstream space and filters locally', async () => {
    client.searchSystems.mockResolvedValue({
      ok: true,
      freshness: FRESHNESS,
      data: [
        {
          system_id: 31000001,
          system_name: 'J100001',
          system_class: 'c1',
          security_status: -1,
          region_id: 11000001,
          region_name: 'A-R00001',
        },
        {
          system_id: 31000002,
          system_name: 'J100009',
          system_class: 'c2',
          security_status: -1,
          region_id: 11000002,
          region_name: 'B-R00001',
          jove_observatory: true,
        },
      ],
    });

    const result = await executeEveScoutTool({} as never, 'scout_systems', {
      query: ' J100 ',
      space: 'c1',
      limit: 10,
    });

    expect(client.searchSystems).toHaveBeenCalledWith({}, 'J100', 'j-space', 100);
    expect(result).toMatchObject({
      ok: true,
      source: 'EVE-Scout',
      authoritative: false,
      query: 'J100',
      space: 'c1',
      count: 1,
      systems: [{
        system_id: 31000001,
        system_name: 'J100001',
        system_class: 'c1',
        region_id: 11000001,
        region_name: 'A-R00001',
        jove_observatory: false,
      }],
    });
  });

  it('strictly validates direct and programmatic limits without clamping', async () => {
    expect(validateScoutSystemsArgs({ query: 'Jita', space: null, limit: null })).toEqual({
      ok: true,
      args: { query: 'Jita', space: null, limit: 10 },
    });
    expect(validateScoutSystemsArgs({ query: 'Jita', space: null, limit: 11 }, { programmatic: true })).toEqual({
      ok: false,
      error: 'Programmatic scout_systems limit cannot exceed 10',
    });
    expect(validateScoutSystemsArgs({ query: 'Jita', space: 'k-space', limit: 5 })).toMatchObject({ ok: false });
    const result = await executeEveScoutTool({} as never, 'scout_systems', {
      query: 'Jita', space: null, limit: 26,
    });
    expect(result).toMatchObject({ ok: false, source: 'EVE-Scout', blocked: false });
    expect(client.searchSystems).not.toHaveBeenCalled();
  });

  it('projects upstream failures without returning raw transport text', async () => {
    client.searchSystems.mockResolvedValue({
      ok: false,
      status: 503,
      error: 'raw upstream body and query details must not escape',
    });

    const result = await executeEveScoutTool({} as never, 'scout_systems', {
      query: 'Jita', space: null, limit: 5,
    });
    expect(result).toEqual({
      ok: false,
      source: 'EVE-Scout',
      authoritative: false,
      error: 'EVE-Scout HTTP 503',
      status: 503,
      blocked: false,
    });
    expect(JSON.stringify(result)).not.toContain('raw upstream');
  });

  it('returns a schema-shaped error instead of emitting an oversized systems result', async () => {
    client.searchSystems.mockResolvedValue({
      ok: true,
      freshness: FRESHNESS,
      data: Array.from({ length: 25 }, (_, index) => ({
        system_id: 31_000_000 + index,
        system_name: `J${String(index).padStart(6, '0')}${'x'.repeat(500)}`,
        system_class: 'c1',
        security_status: -1,
        region_id: 11_000_001,
        region_name: `A-R00001${'y'.repeat(500)}`,
      })),
    });

    const result = await executeEveScoutTool({} as never, 'scout_systems', {
      query: 'J', space: null, limit: 25,
    });
    expect(result).toEqual({
      ok: false,
      source: 'EVE-Scout',
      authoritative: false,
      error: 'EVE-Scout result exceeds the local output size limit',
      status: null,
      blocked: false,
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(12_000);
  });
});
