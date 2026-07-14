import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const eveKillMocks = vi.hoisted(() => ({ searchKillmails: vi.fn() }));
const esiMocks = vi.hoisted(() => ({ callEsiOperation: vi.fn() }));

vi.mock('../../src/eve-kill/client.js', () => ({
  searchKillmails: eveKillMocks.searchKillmails,
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: esiMocks.callEsiOperation,
}));

vi.mock('../../src/agent/native-responses.js', () => ({
  createNativeResponse: vi.fn(),
  toNativeMessage: (text: string) => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  }),
}));

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe('osint inference via EVE-KILL search', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)')
      .run(10000070, 'Delve', '{}');
    db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)')
      .run(20000070, 'Core', 10000070, '{}');
    db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)')
      .run(30007001, 'X-70MU', 20000070, JSON.stringify({ security: -0.6 }));
    eveKillMocks.searchKillmails.mockReset();
    esiMocks.callEsiOperation.mockReset();
  });

  it('uses official ESI names and labels observed membership as non-authoritative with search coverage', async () => {
    eveKillMocks.searchKillmails.mockResolvedValue({
      ok: true,
      data: {
        kills: [{
          killmailId: 41,
          killmailTime: isoDaysAgo(1),
          solarSystemId: 30007001,
          totalValue: 900_000_000,
          attackerCount: 1,
          isNpc: false,
          isSolo: true,
          victim: { characterId: 9001, corporationId: 4001, shipTypeId: 11 },
          attackers: [{ characterId: 9002, corporationId: 4001, shipTypeId: 12, finalBlow: true }],
          items: [],
          siblings: [],
          sourceShape: 'esi',
        }],
        truncated: true,
        requestCount: 3,
        windows: [{ from: isoDaysAgo(7), to: new Date().toISOString() }],
      },
    });
    esiMocks.callEsiOperation.mockImplementation(async (
      _db: Database.Database,
      operation: string,
      args: Record<string, unknown>,
    ) => {
      expect(operation).toBe('post_universe_names');
      const ids = JSON.parse(String(args.ids)) as number[];
      return {
        ok: true,
        status: 200,
        cached: false,
        headers: {},
        data: ids.map((id) => ({
          id,
          name: id === 4001 ? 'Official Corp Name' : `Official Pilot ${id}`,
        })),
      };
    });

    const { executeOsintInferHome } = await import('../../src/eve-osint/inference.js');
    const result = await executeOsintInferHome(db, {
      scope: 'corporation',
      id: 4001,
      window_days: 30,
      include_member_analysis: true,
      include_graph: true,
      include_llm_pattern_analysis: false,
    });

    expect(result.ok).toBe(true);
    expect(result.entity_name).toBe('Official Corp Name');
    expect(eveKillMocks.searchKillmails).toHaveBeenCalledTimes(1);
    expect(eveKillMocks.searchKillmails.mock.calls[0]?.[1]).toMatchObject({
      corporation_ids: [4001],
    });
    expect(result.hypotheses[0]).toMatchObject({ system_name: 'X-70MU' });
    expect(result.member_analysis).toMatchObject({
      authoritative: false,
      source: 'eve-kill',
      basis: 'observed_killboard_activity',
      window_days: 30,
      total_members_observed: 2,
      coverage: {
        truncated: true,
        request_count: 3,
      },
    });
    expect(result.member_analysis.core_members.map((entry: { character_name: string }) => entry.character_name))
      .toEqual(expect.arrayContaining(['Official Pilot 9001', 'Official Pilot 9002']));
    expect(result.uncertainty).toContain('EVE-KILL activity search was truncated at the configured result/request cap.');
  });

  it('returns explicit source failure coverage instead of inventing members', async () => {
    eveKillMocks.searchKillmails.mockResolvedValue({ ok: false, error: 'upstream unavailable', status: 503 });
    esiMocks.callEsiOperation.mockResolvedValue({
      ok: true,
      status: 200,
      cached: false,
      headers: {},
      data: [{ id: 4001, name: 'Official Corp Name' }],
    });

    const { executeOsintInferHome } = await import('../../src/eve-osint/inference.js');
    const result = await executeOsintInferHome(db, {
      scope: 'corporation',
      id: 4001,
      window_days: 7,
      include_member_analysis: true,
      include_graph: false,
      include_llm_pattern_analysis: false,
    });

    expect(result.member_analysis).toMatchObject({
      authoritative: false,
      total_members_observed: 0,
      coverage: { truncated: false, request_count: 0, windows: [] },
    });
    expect(result.uncertainty).toContain('EVE-KILL activity search failed: upstream unavailable');
  });
});
