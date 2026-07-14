import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { validateProgrammaticToolOutput } from '../../src/agent/programmatic-contracts.js';
import type { NormalizedKillmail } from '../../src/eve-kill/types.js';
import { executeEveKillTool } from '../../src/eve-kill/executor.js';

const clientMocks = vi.hoisted(() => ({ searchKillmails: vi.fn() }));

vi.mock('../../src/eve-kill/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/eve-kill/client.js')>()),
  searchKillmails: clientMocks.searchKillmails,
}));

import {
  executeKillActivitySummary,
  validateKillActivitySummaryArgs,
} from '../../src/eve-kill/activity-summary.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  clientMocks.searchKillmails.mockReset();
});

afterEach(() => db.close());

describe('kill_activity_summary', () => {
  it('dispatches through the public EVE-KILL executor without a chat/private context', async () => {
    clientMocks.searchKillmails.mockResolvedValue(success([]));
    const result = await executeEveKillTool(db, 'kill_activity_summary', args());

    expect(result).toMatchObject({
      ok: true,
      source: 'EVE-KILL',
      authoritative: false,
      coverage: { observed: 0, truncated: false },
    });
  });

  it('derives deterministic entity roles, values, flags, freshness, and evidence', async () => {
    clientMocks.searchKillmails.mockResolvedValue(success([
      kill(3, '2026-07-13T12:00:00Z', {
        victimCharacterId: 77,
        attackerCharacterIds: [77],
        totalValue: 30,
        isNpc: true,
      }),
      kill(1, '2026-07-13T10:00:00Z', {
        victimCharacterId: 11,
        attackerCharacterIds: [77],
        totalValue: 10,
      }),
      kill(2, '2026-07-13T11:00:00Z', {
        victimCharacterId: 77,
        attackerCharacterIds: [22],
        isSolo: true,
      }),
    ]));

    const result = await executeKillActivitySummary(db, args({ evidence_limit: null }));

    expect(clientMocks.searchKillmails).toHaveBeenCalledWith(
      db,
      {
        from: '2026-07-13T00:00:00.000Z',
        to: '2026-07-14T00:00:00.000Z',
        character_ids: [77],
      },
      { limit: 100, maxRequests: 4 },
    );
    expect(result).toMatchObject({
      ok: true,
      source: 'EVE-KILL',
      authoritative: false,
      limitation: 'Third-party public killboard observation; coverage may be incomplete.',
      freshness: {
        data_through: '2026-07-13T12:00:00Z',
        cache_max_age_seconds: 90,
      },
      scope: 'character',
      id: 77,
      activity: 'all',
      window: {
        from: '2026-07-13T00:00:00.000Z',
        to: '2026-07-14T00:00:00.000Z',
      },
      coverage: { observed: 3, truncated: false },
      aggregates: {
        kills: 2,
        losses: 2,
        dual_role: 1,
        npc: 1,
        solo: 1,
        valued: 2,
        total_value_isk: 40,
        first_killmail_time: '2026-07-13T10:00:00Z',
        last_killmail_time: '2026-07-13T12:00:00Z',
      },
      evidence_killmail_ids: [3, 2, 1],
    });
    expect(typeof (result.freshness as Record<string, unknown>).retrieved_at).toBe('string');
    expect(validateProgrammaticToolOutput('kill_activity_summary', result)).toEqual({
      valid: true,
      errors: [],
    });
    expect((result.coverage as { observed: number }).observed).toBe(
      (result.aggregates as { kills: number; losses: number; dual_role: number }).kills
      + (result.aggregates as { losses: number }).losses
      - (result.aggregates as { dual_role: number }).dual_role,
    );
  });

  it('filters kills and losses while retaining dual-role semantics', async () => {
    const rows = [
      kill(3, '2026-07-13T12:00:00Z', { victimCharacterId: 77, attackerCharacterIds: [77] }),
      kill(2, '2026-07-13T11:00:00Z', { victimCharacterId: 77, attackerCharacterIds: [22] }),
      kill(1, '2026-07-13T10:00:00Z', { victimCharacterId: 11, attackerCharacterIds: [77] }),
    ];
    clientMocks.searchKillmails.mockResolvedValue(success(rows));
    const kills = await executeKillActivitySummary(db, args({ activity: 'kills' }));
    clientMocks.searchKillmails.mockResolvedValue(success(rows));
    const losses = await executeKillActivitySummary(db, args({ activity: 'losses' }));

    expect(kills).toMatchObject({
      coverage: { observed: 2 },
      aggregates: { kills: 2, losses: 1, dual_role: 1 },
      evidence_killmail_ids: [3, 1],
    });
    expect(losses).toMatchObject({
      coverage: { observed: 2 },
      aggregates: { kills: 1, losses: 2, dual_role: 1 },
      evidence_killmail_ids: [3, 2],
    });
  });

  it('uses system semantics and returns honest empty/missing-value aggregates', async () => {
    clientMocks.searchKillmails.mockResolvedValue(success([
      kill(9, '2026-07-13T12:00:00Z', { systemId: 30000142 }),
    ]));
    const system = await executeKillActivitySummary(db, args({
      scope: 'system', id: 30000142, activity: 'all', evidence_limit: 1,
    }));
    expect(system).toMatchObject({
      coverage: { observed: 1 },
      aggregates: {
        kills: 1,
        losses: 0,
        dual_role: 0,
        npc: 0,
        solo: 0,
        valued: 0,
        total_value_isk: 0,
      },
      evidence_killmail_ids: [9],
    });

    clientMocks.searchKillmails.mockResolvedValue(success([]));
    const empty = await executeKillActivitySummary(db, args());
    expect(empty).toMatchObject({
      freshness: { data_through: null },
      coverage: { observed: 0, truncated: false },
      aggregates: {
        kills: 0,
        losses: 0,
        dual_role: 0,
        valued: 0,
        total_value_isk: 0,
        first_killmail_time: null,
        last_killmail_time: null,
      },
      evidence_killmail_ids: [],
    });
  });

  it('deduplicates IDs and orders equal-time evidence by descending ID', async () => {
    clientMocks.searchKillmails.mockResolvedValue(success([
      kill(4, '2026-07-13T12:00:00Z', { victimCharacterId: 11, attackerCharacterIds: [77] }),
      kill(6, '2026-07-13T12:00:00Z', { victimCharacterId: 11, attackerCharacterIds: [77] }),
      kill(4, '2026-07-13T12:00:00Z', { victimCharacterId: 11, attackerCharacterIds: [77] }),
      kill(5, '2026-07-13T12:00:00Z', { victimCharacterId: 11, attackerCharacterIds: [77] }),
    ]));

    const result = await executeKillActivitySummary(db, args({ activity: 'kills', evidence_limit: 2 }));
    expect(result).toMatchObject({
      coverage: { observed: 3 },
      evidence_killmail_ids: [6, 5],
    });
  });

  it('caps defensive oversized input at 100 observations and preserves truncation', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => kill(
      index + 1,
      `2026-07-13T12:${String(index % 60).padStart(2, '0')}:00Z`,
      { victimCharacterId: 11, attackerCharacterIds: [77] },
    ));
    clientMocks.searchKillmails.mockResolvedValue(success(rows, true));

    const result = await executeKillActivitySummary(db, args({ activity: 'kills', evidence_limit: 10 }));
    expect(result).toMatchObject({ coverage: { observed: 100, truncated: true } });
    expect((result.evidence_killmail_ids as number[])).toHaveLength(10);
  });

  it.each([
    { patch: { scope: 'invalid' }, error: 'Invalid kill_activity_summary arguments.' },
    { patch: { id: 0 }, error: 'Invalid kill_activity_summary arguments.' },
    { patch: { evidence_limit: 11 }, error: 'Invalid kill_activity_summary arguments.' },
    { patch: { from: '2026-07-13T00:00:00+03:00' }, error: 'Invalid kill_activity_summary arguments.' },
    { patch: { to: '2026-07-13T00:00:00Z' }, error: 'from/to must define a positive UTC window of at most seven days.' },
    { patch: { to: '2026-07-21T00:00:00Z' }, error: 'from/to must define a positive UTC window of at most seven days.' },
    { patch: { scope: 'system', id: 30000142, activity: 'kills' }, error: 'System scope requires activity=all.' },
    { patch: { extra: true }, error: 'Invalid kill_activity_summary arguments.' },
  ])('rejects invalid arguments before egress: $patch', async ({ patch, error }) => {
    const result = await executeKillActivitySummary(db, args(patch));
    expect(result).toEqual({
      ok: false,
      source: 'EVE-KILL',
      authoritative: false,
      error,
      status: null,
      blocked: false,
    });
    expect(clientMocks.searchKillmails).not.toHaveBeenCalled();
  });

  it('exports caller-aware validation with the tighter programmatic evidence cap', () => {
    expect(validateKillActivitySummaryArgs(args({ evidence_limit: 10 })).ok).toBe(true);
    expect(validateKillActivitySummaryArgs(args({ evidence_limit: 5 }), { programmatic: true }).ok).toBe(true);
    expect(validateKillActivitySummaryArgs(args({ evidence_limit: 6 }), { programmatic: true })).toMatchObject({
      ok: false,
      error: { source: 'EVE-KILL', blocked: false },
    });
  });

  it('fails closed on an out-of-scope upstream row and sanitizes source failures', async () => {
    clientMocks.searchKillmails.mockResolvedValue(success([
      kill(1, '2026-07-13T12:00:00Z', { victimCharacterId: 11, attackerCharacterIds: [22] }),
    ]));
    expect(await executeKillActivitySummary(db, args())).toEqual({
      ok: false,
      source: 'EVE-KILL',
      authoritative: false,
      error: 'EVE-KILL returned an invalid response.',
      status: null,
      blocked: false,
    });

    clientMocks.searchKillmails.mockResolvedValue({
      ok: false,
      error: 'EVE-KILL HTTP 503 upstream-private-body',
      status: 503,
    });
    const failed = await executeKillActivitySummary(db, args());
    expect(failed).toEqual({
      ok: false,
      source: 'EVE-KILL',
      authoritative: false,
      error: 'EVE-KILL request failed with HTTP status 503.',
      status: 503,
      blocked: false,
    });
    expect(JSON.stringify(failed)).not.toContain('upstream-private-body');
    expect(validateProgrammaticToolOutput('kill_activity_summary', failed)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('never exposes raw killmail fields or transport internals', async () => {
    clientMocks.searchKillmails.mockResolvedValue(success([
      kill(1, '2026-07-13T12:00:00Z', { victimCharacterId: 77, attackerCharacterIds: [77] }),
    ]));
    const result = await executeKillActivitySummary(db, args());
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'killmail_hash', 'victim', 'attackers', 'character_id', 'corporation_id', 'alliance_id',
      'ship_type_id', 'items', 'fitting', 'position', 'pagination', 'requestCount', 'cursor', 'retry',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    expect(serialized.length).toBeLessThan(12_000);
  });
});

function args(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'character',
    id: 77,
    activity: 'all',
    from: '2026-07-13T00:00:00Z',
    to: '2026-07-14T00:00:00Z',
    evidence_limit: 5,
    ...patch,
  };
}

function success(kills: NormalizedKillmail[], truncated = false): Record<string, unknown> {
  return {
    ok: true,
    data: {
      kills,
      truncated,
      requestCount: 1,
      windows: [{ from: '2026-07-13T00:00:00Z', to: '2026-07-14T00:00:00Z' }],
    },
  };
}

function kill(
  killmailId: number,
  killmailTime: string,
  options: {
    systemId?: number;
    victimCharacterId?: number;
    attackerCharacterIds?: number[];
    totalValue?: number;
    isNpc?: boolean;
    isSolo?: boolean;
  } = {},
): NormalizedKillmail {
  return {
    killmailId,
    killmailTime,
    solarSystemId: options.systemId ?? 30000142,
    totalValue: options.totalValue,
    attackerCount: options.attackerCharacterIds?.length ?? 0,
    isNpc: options.isNpc,
    isSolo: options.isSolo,
    victim: {
      characterId: options.victimCharacterId,
      corporationId: 100,
      shipTypeId: 587,
    },
    attackers: (options.attackerCharacterIds ?? []).map((characterId) => ({ characterId })),
    items: [],
    siblings: [],
    sourceShape: 'esi',
  };
}
