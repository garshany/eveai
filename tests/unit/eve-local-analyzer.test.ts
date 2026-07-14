import { beforeEach, describe, expect, it, vi } from 'vitest';

const esiMocks = vi.hoisted(() => ({ callEsiOperation: vi.fn() }));
const eveKillMocks = vi.hoisted(() => ({ batchCharacterStats: vi.fn() }));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: esiMocks.callEsiOperation,
}));

vi.mock('../../src/eve-kill/client.js', () => ({
  batchCharacterStats: eveKillMocks.batchCharacterStats,
}));

describe('analyze_local current EVE-KILL batch path', () => {
  beforeEach(() => {
    esiMocks.callEsiOperation.mockReset();
    eveKillMocks.batchCharacterStats.mockReset();
  });

  it('keeps ESI identity/affiliation and reports partial batch stats coverage', async () => {
    esiMocks.callEsiOperation.mockImplementation(async (
      _db: unknown,
      operation: string,
      args: Record<string, unknown>,
    ) => {
      if (operation === 'post_universe_ids') {
        expect(JSON.parse(String(args.names))).toEqual(['Pilot One', 'Pilot Two']);
        return success({ characters: [{ id: 101, name: 'Pilot One' }, { id: 102, name: 'Pilot Two' }] });
      }
      if (operation === 'post_characters_affiliation') {
        expect(JSON.parse(String(args.characters))).toEqual([101, 102]);
        return success([
          { character_id: 101, corporation_id: 201 },
          { character_id: 102, corporation_id: 201 },
        ]);
      }
      if (operation === 'post_universe_names') {
        expect(JSON.parse(String(args.ids))).toEqual([201]);
        return success([{ id: 201, name: 'Official Corporation', category: 'corporation' }]);
      }
      throw new Error(`unexpected ESI operation: ${operation}`);
    });
    eveKillMocks.batchCharacterStats.mockResolvedValue({
      ok: true,
      data: {
        period: 'range',
        results: [{
          id: 101,
          kills: 12,
          losses: 2,
          soloKills: 4,
          npcLosses: 0,
          iskDestroyed: 2_500_000_000,
          iskLost: 200_000_000,
          topShips: [{ shipTypeId: 587, shipName: 'Rifter', kills: 8, losses: 1 }],
          raw: {},
        }],
        requestedIds: [101, 102],
        resolvedIds: [101],
        missingIds: [102],
        truncated: true,
        requestCount: 1,
      },
    });

    const { executeAnalyzeLocal } = await import('../../src/eve-local/analyzer.js');
    const result = await executeAnalyzeLocal({} as never, {
      pilots: 'Pilot One\nPilot Two',
      days: 14,
    }) as {
      scan: { stats_source: string; stats_coverage: Record<string, unknown> };
      no_alliance: Array<{ name: string; pilots: Array<Record<string, unknown>> }>;
    };

    expect(eveKillMocks.batchCharacterStats).toHaveBeenCalledTimes(1);
    expect(eveKillMocks.batchCharacterStats).toHaveBeenCalledWith(
      expect.anything(),
      [101, 102],
      expect.objectContaining({ type: 'range' }),
    );
    expect(result.scan).toMatchObject({
      stats_source: 'eve-kill',
      stats_coverage: {
        requested: 2,
        resolved: 1,
        missing: 1,
        missing_ids: [102],
        truncated: true,
        request_count: 1,
      },
    });
    expect(result.no_alliance[0]).toMatchObject({
      name: 'Official Corporation',
      pilots: expect.arrayContaining([
        expect.objectContaining({ name: 'Pilot One', threat: 'high', ships: ['Rifter'] }),
        expect.objectContaining({ name: 'Pilot Two', threat: 'unknown' }),
      ]),
    });
  });
});

function success<T>(data: T): Record<string, unknown> {
  return { ok: true, status: 200, cached: false, headers: {}, data };
}
