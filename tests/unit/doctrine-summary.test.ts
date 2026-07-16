import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateProgrammaticToolOutput } from '../../src/agent/programmatic-contracts.js';

const mocks = vi.hoisted(() => ({ executeAnalytics: vi.fn() }));
vi.mock('../../src/eve-kill/mcp-analytics.js', () => ({
  executeEveKillAnalyticsTool: mocks.executeAnalytics,
}));

import {
  DOCTRINE_SUMMARY_TOOL,
  executeDoctrineSummary,
  isDoctrineSummaryTool,
  validateDoctrineSummaryArgs,
} from '../../src/eve-kill/doctrine-summary.js';

const db = {} as never;
const args = {
  entity_id: 99,
  entity_type: 'alliance',
  from: '2026-07-01T00:00:00Z',
  to: '2026-07-15T00:00:00Z',
  top: 5,
} as const;
const hash = 'a'.repeat(64);

beforeEach(() => mocks.executeAnalytics.mockReset());

describe('doctrine_summary facade', () => {
  it('declares a strict direct tool and enforces keys, canonical windows, bounds, and programmatic top before egress', async () => {
    expect(DOCTRINE_SUMMARY_TOOL).toMatchObject({
      name: 'doctrine_summary', strict: true,
      parameters: {
        required: ['entity_id', 'entity_type', 'from', 'to', 'top'],
        additionalProperties: false,
      },
    });
    expect(DOCTRINE_SUMMARY_TOOL.defer_loading).toBeUndefined();
    expect(isDoctrineSummaryTool('doctrine_summary')).toBe(true);
    expect(validateDoctrineSummaryArgs({ ...args, top: 10 })).toMatchObject({ ok: true });
    expect(validateDoctrineSummaryArgs({ ...args, top: 6 }, { programmatic: true })).toMatchObject({
      ok: false, error: { blocked: true },
    });
    for (const invalid of [
      { ...args, entity_id: 0 },
      { ...args, entity_type: 'character' },
      { ...args, from: '2026-07-01' },
      { ...args, from: args.to },
      { ...args, from: '2025-01-01T00:00:00Z' },
      { ...args, top: 11 },
      { ...args, private: 'secret' },
    ]) {
      expect(await executeDoctrineSummary(db, invalid)).toMatchObject({ ok: false, blocked: true });
    }
    expect(mocks.executeAnalytics).not.toHaveBeenCalled();
  });

  it('reconstructs fixed public arguments and projects the live entity/window/count/clusters shape', async () => {
    mocks.executeAnalytics.mockResolvedValue(wrapper({
      entity: { id: 99, name: ' Example Alliance ', type: 'alliance', url: 'https://upstream.invalid/entity/99' },
      window: { since: '2026-07-01T00:00:00+00:00', until: '2026-07-15T00:00:00Z' },
      count: 1,
      clusters: [{
        family_hash: hash,
        ship: { type_id: 587, name: ' Rifter ' },
        signature: ' Shield doctrine ',
        losses: 3,
        isk_lost: 123.123456789,
        avg_isk_per_loss: 41.041152263,
        example_killmail: {
          killmail_id: 777,
          url: 'https://upstream.invalid/kill/777',
          modules: [{ type_id: 1, name: 'private raw module evidence' }],
        },
        first_loss: '2026-07-02 10:20:30+00',
        last_loss: '2026-07-14 11:22:33+00',
      }],
    }));
    const result = await executeDoctrineSummary(db, args);

    expect(mocks.executeAnalytics).toHaveBeenCalledWith('doctrine_detect', {
      entity: 99,
      type: 'alliance',
      since: '2026-07-01T00:00:00.000Z',
      until: '2026-07-15T00:00:00.000Z',
      include_rookie_ships: false,
      limit: 5,
    });
    expect(result).toMatchObject({
      ok: true,
      source: 'EVE-KILL MCP',
      authoritative: false,
      limitation: 'Third-party public loss-fit inference; coverage and doctrine classifications may be incomplete.',
      freshness: { data_through: '2026-07-14T11:22:33.000Z', cache_max_age_seconds: null },
      entity: { id: 99, type: 'alliance', name: 'Example Alliance' },
      window: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-15T00:00:00.000Z' },
      count: 1,
      doctrines: [{
        family_id: hash,
        signature: 'Shield doctrine',
        ship_type_id: 587,
        ship_name: 'Rifter',
        losses: 3,
        isk_lost: 123.123457,
        average_isk_per_loss: 41.041152,
        first_loss: '2026-07-02T10:20:30.000Z',
        last_loss: '2026-07-14T11:22:33.000Z',
        evidence_killmail_id: 777,
      }],
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of ['entity/99', 'kill/777', 'modules', 'private raw module evidence', 'transport', 'clusters']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(validateProgrammaticToolOutput('doctrine_summary', result)).toEqual({ valid: true, errors: [] });
  });

  it('accepts a valid empty payload and optional upstream notes without fabricating doctrine data', async () => {
    mocks.executeAnalytics.mockResolvedValue(wrapper({
      entity: { id: 99, name: 'Example', type: 'alliance', url: 'https://upstream.invalid/entity/99' },
      window: { since: args.from, until: args.to },
      count: 0,
      clusters: [],
      notes: ['no observations'],
    }));
    expect(await executeDoctrineSummary(db, args)).toMatchObject({
      ok: true,
      freshness: { data_through: null },
      count: 0,
      doctrines: [],
    });
  });

  it('fails closed on identity/window/count/hash/date/nested drift and non-finite numbers', async () => {
    const valid = {
      entity: { id: 99, name: 'Example', type: 'alliance', url: 'https://upstream.invalid/entity/99' },
      window: { since: args.from, until: args.to },
      count: 1,
      clusters: [{
        family_hash: hash,
        ship: { type_id: 587, name: 'Rifter' },
        signature: 'Shield',
        losses: 3,
        isk_lost: 120,
        avg_isk_per_loss: 40,
        example_killmail: { killmail_id: 777, url: 'https://upstream.invalid/k', modules: [] },
        first_loss: '2026-07-02T00:00:00Z',
        last_loss: '2026-07-03T00:00:00Z',
      }],
    };
    const cases = [
      { ...valid, entity: { ...valid.entity, id: 100 } },
      { ...valid, window: { ...valid.window, until: '2026-07-14T00:00:00Z' } },
      { ...valid, count: 2 },
      { ...valid, clusters: [{ ...valid.clusters[0], family_hash: 'BAD' }] },
      { ...valid, clusters: [{ ...valid.clusters[0], first_loss: 'not-a-date' }] },
      { ...valid, clusters: [{ ...valid.clusters[0], isk_lost: Number.NaN }] },
      { ...valid, clusters: [{ ...valid.clusters[0], example_killmail: { ...valid.clusters[0].example_killmail, modules: 'raw' } }] },
      { ...valid, entity: { ...valid.entity, name: 'Example\u0007Alliance' } },
      { ...valid, clusters: [{ ...valid.clusters[0], signature: 'Shield\nDoctrine' }] },
    ];
    for (const data of cases) {
      mocks.executeAnalytics.mockResolvedValue(wrapper(data));
      expect(await executeDoctrineSummary(db, args)).toEqual({
        ok: false, source: 'EVE-KILL MCP', authoritative: false,
        error: 'EVE-KILL MCP returned an invalid doctrine response.', status: null, blocked: false,
      });
    }
  });

  it('sanitizes wrapper errors and never reflects upstream details', async () => {
    mocks.executeAnalytics.mockResolvedValue({
      ok: false, source: 'EVE-KILL MCP', status: 503, error: 'secret URL raw payload',
    });
    const result = await executeDoctrineSummary(db, args);
    expect(result).toEqual({
      ok: false, source: 'EVE-KILL MCP', authoritative: false,
      error: 'EVE-KILL doctrine request failed with HTTP status 503.', status: 503, blocked: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

function wrapper(data: unknown) {
  return {
    ok: true,
    source: 'EVE-KILL MCP',
    transport: 'local_public_wrapper',
    tool: 'doctrine_detect',
    authoritative: false,
    limitation: 'untrusted upstream limitation',
    data,
  };
}
