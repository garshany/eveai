import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateProgrammaticToolOutput } from '../../src/agent/programmatic-contracts.js';

const mocks = vi.hoisted(() => ({ callEsiOperation: vi.fn() }));
vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: mocks.callEsiOperation }));

import {
  SYSTEM_METRIC_SNAPSHOT_TOOL,
  executeSystemMetricSnapshot,
  isSystemMetricSnapshotTool,
  validateSystemMetricSnapshotArgs,
} from '../../src/eve/system-metric-snapshot.js';

const db = {} as never;

beforeEach(() => mocks.callEsiOperation.mockReset());

describe('system_metric_snapshot facade', () => {
  it('declares the strict surface and rejects unknown, duplicate, unsafe, empty, and oversized input before egress', async () => {
    expect(SYSTEM_METRIC_SNAPSHOT_TOOL).toMatchObject({
      name: 'system_metric_snapshot', strict: true,
      parameters: { required: ['metric', 'system_ids'], additionalProperties: false },
    });
    expect(SYSTEM_METRIC_SNAPSHOT_TOOL.defer_loading).toBeUndefined();
    expect(isSystemMetricSnapshotTool('system_metric_snapshot')).toBe(true);
    expect(validateSystemMetricSnapshotArgs({ metric: 'kills', system_ids: [3, 1] })).toMatchObject({
      ok: true, data: { metric: 'kills', system_ids: [3, 1] },
    });
    for (const args of [
      { metric: 'other', system_ids: [1] },
      { metric: 'kills', system_ids: [] },
      { metric: 'kills', system_ids: [1, 1] },
      { metric: 'kills', system_ids: [0] },
      { metric: 'kills', system_ids: Array.from({ length: 101 }, (_, index) => index + 1) },
      { metric: 'kills', system_ids: [1], private: 'secret' },
    ]) {
      expect(await executeSystemMetricSnapshot(db, args)).toMatchObject({ ok: false, blocked: true });
    }
    expect(mocks.callEsiOperation).not.toHaveBeenCalled();
  });

  it.each([
    {
      metric: 'kills', operation: 'get_universe_system_kills',
      data: [{ system_id: 2, ship_kills: 4, npc_kills: 5, pod_kills: 6 }],
      rows: [
        { system_id: 3, found: false, ship: null, npc: null, pod: null },
        { system_id: 2, found: true, ship: 4, npc: 5, pod: 6 },
      ],
    },
    {
      metric: 'jumps', operation: 'get_universe_system_jumps',
      data: [{ system_id: 2, ship_jumps: 42 }],
      rows: [
        { system_id: 3, found: false, jumps: null },
        { system_id: 2, found: true, jumps: 42 },
      ],
    },
    {
      metric: 'industry', operation: 'get_industry_systems',
      data: [{
        solar_system_id: 2,
        cost_indices: [
          { activity: 'researching_time_efficiency', cost_index: 0.6 },
          { activity: 'manufacturing', cost_index: 0.1 },
          { activity: 'researching_technology', cost_index: 9.9 },
          { activity: 'copying', cost_index: 0.4 },
        ],
      }],
      rows: [
        { system_id: 3, found: false, cost_indices: [null, null, null, null, null, null] },
        { system_id: 2, found: true, cost_indices: [0.1, null, null, 0.4, null, 0.6] },
      ],
    },
    {
      metric: 'sovereignty', operation: 'get_sovereignty_map',
      data: [{ system_id: 2, alliance_id: 99 }],
      rows: [
        { system_id: 3, found: false, holder_type: 'none', holder_id: null },
        { system_id: 2, found: true, holder_type: 'alliance', holder_id: 99 },
      ],
    },
  ] as const)('projects $metric in requested order and ignores extra upstream systems', async ({ metric, operation, data, rows }) => {
    mocks.callEsiOperation.mockResolvedValue({
      ok: true,
      status: 200,
      cached: false,
      headers: { 'cache-control': 'max-age=3600', 'last-modified': 'Wed, 15 Jul 2026 12:00:00 GMT' },
      data: [...data, extraRow(metric)],
    });
    const result = await executeSystemMetricSnapshot(db, { metric, system_ids: [3, 2] });
    expect(mocks.callEsiOperation).toHaveBeenCalledWith(db, operation, {}, null);
    expect(result).toMatchObject({
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: { data_through: '2026-07-15T12:00:00.000Z', cache_max_age_seconds: 3600 },
      metric,
      count: 2,
      rows,
    });
    expect((result.rows as unknown[])).toEqual(rows);
    expect(validateProgrammaticToolOutput('system_metric_snapshot', result)).toEqual({ valid: true, errors: [] });
  });

  it('rejects duplicate requested rows, conflicting sovereignty, duplicate relevant costs, and malformed extra rows', async () => {
    const cases = [
      {
        metric: 'kills',
        data: [
          { system_id: 2, ship_kills: 1, npc_kills: 2, pod_kills: 3 },
          { system_id: 2, ship_kills: 1, npc_kills: 2, pod_kills: 3 },
        ],
      },
      { metric: 'sovereignty', data: [{ system_id: 2, alliance_id: 3, corporation_id: 4 }] },
      {
        metric: 'industry',
        data: [{ solar_system_id: 2, cost_indices: [
          { activity: 'manufacturing', cost_index: 0.1 },
          { activity: 'manufacturing', cost_index: 0.1 },
        ] }],
      },
      {
        metric: 'jumps',
        data: [{ system_id: 999, ship_jumps: Number.NaN }],
      },
    ];
    for (const testCase of cases) {
      mocks.callEsiOperation.mockResolvedValue({ ok: true, status: 200, cached: false, headers: {}, data: testCase.data });
      expect(await executeSystemMetricSnapshot(db, { metric: testCase.metric, system_ids: [2] })).toEqual({
        ok: false, source: 'CCP ESI', authoritative: true,
        error: 'CCP ESI returned an invalid system metric response.', status: null, blocked: false,
      });
    }
  });

  it('rejects upstream bulk arrays larger than 10000 rows', async () => {
    mocks.callEsiOperation.mockResolvedValue({
      ok: true,
      status: 200,
      cached: false,
      headers: {},
      data: Array.from({ length: 10_001 }, (_, index) => ({
        system_id: index + 1,
        ship_jumps: 0,
      })),
    });
    expect(await executeSystemMetricSnapshot(db, { metric: 'jumps', system_ids: [1] })).toMatchObject({
      ok: false,
      error: 'CCP ESI returned an invalid system metric response.',
      blocked: false,
    });
  });

  it('sanitizes transport errors and does not expose upstream payloads', async () => {
    mocks.callEsiOperation.mockResolvedValue({ ok: false, status: 502, error: 'secret URL and response' });
    const result = await executeSystemMetricSnapshot(db, { metric: 'kills', system_ids: [2] });
    expect(result).toEqual({
      ok: false, source: 'CCP ESI', authoritative: true,
      error: 'CCP ESI system metric request failed with HTTP status 502.', status: 502, blocked: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

function extraRow(metric: string): Record<string, unknown> {
  if (metric === 'kills') return { system_id: 999, ship_kills: 0, npc_kills: 0, pod_kills: 0 };
  if (metric === 'jumps') return { system_id: 999, ship_jumps: 0 };
  if (metric === 'industry') return { solar_system_id: 999, cost_indices: [] };
  return { system_id: 999 };
}
