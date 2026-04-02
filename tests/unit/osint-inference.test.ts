import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const eveKillMocks = vi.hoisted(() => ({
  getEntityDetail: vi.fn(),
  getEntityMembers: vi.fn(),
}));

const zkillMocks = vi.hoisted(() => ({
  fetchEntityActivityFeed: vi.fn(),
}));

const esiMocks = vi.hoisted(() => ({
  callEsiOperation: vi.fn(),
}));

const llmMocks = vi.hoisted(() => ({
  createNativeResponse: vi.fn(),
}));

vi.mock('../../src/eve-kill/client.js', () => ({
  getEntityDetail: eveKillMocks.getEntityDetail,
  getEntityMembers: eveKillMocks.getEntityMembers,
}));

vi.mock('../../src/eve-osint/zkill.js', () => ({
  fetchEntityActivityFeed: zkillMocks.fetchEntityActivityFeed,
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: esiMocks.callEsiOperation,
}));

vi.mock('../../src/agent/native-responses.js', () => ({
  createNativeResponse: llmMocks.createNativeResponse,
  toNativeMessage: (text: string) => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  }),
}));

describe('osint inference', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.resetModules();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
      10000070, 'Delve', JSON.stringify({ region_id: 10000070, name: 'Delve' }),
    );
    db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
      10000002, 'The Forge', JSON.stringify({ region_id: 10000002, name: 'The Forge' }),
    );
    db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
      20000070, 'Core', 10000070, JSON.stringify({ constellation_id: 20000070, region_id: 10000070, name: 'Core' }),
    );
    db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
      20000002, 'Forge Core', 10000002, JSON.stringify({ constellation_id: 20000002, region_id: 10000002, name: 'Forge Core' }),
    );
    db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
      30007001, 'X-70MU', 20000070, JSON.stringify({ system_id: 30007001, constellation_id: 20000070, security: -0.6 }),
    );
    db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
      30007002, 'Y-2ANO', 20000070, JSON.stringify({ system_id: 30007002, constellation_id: 20000070, security: -0.4 }),
    );
    db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
      30000142, 'Jita', 20000002, JSON.stringify({ system_id: 30000142, constellation_id: 20000002, security: 0.9 }),
    );
    db.prepare(`INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, ?, ?)`).run(
      1, 30007001, 30007002, 2, '{}',
    );
    db.prepare(`INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, ?, ?)`).run(
      2, 30007002, 30007001, 1, '{}',
    );

    eveKillMocks.getEntityDetail.mockReset();
    eveKillMocks.getEntityMembers.mockReset();
    zkillMocks.fetchEntityActivityFeed.mockReset();
    esiMocks.callEsiOperation.mockReset();
    llmMocks.createNativeResponse.mockReset();
  });

  it('builds deterministic hypotheses and member summary for corporation analysis', async () => {
    eveKillMocks.getEntityDetail.mockResolvedValue({ ok: true, data: { name: 'Corp X' } });
    eveKillMocks.getEntityMembers.mockResolvedValue({
      ok: true,
      data: [
        { character_id: 9001, character_name: 'Pilot One' },
        { character_id: 9002, character_name: 'Pilot Two' },
      ],
    });
    zkillMocks.fetchEntityActivityFeed.mockImplementation(async (_db: Database.Database, args: Record<string, unknown>) => {
      if (args.activity === 'kills') {
        return [
          { activity: 'kills', killmail_id: 2, killmail_time: '2026-03-29T12:00:00Z', solar_system_id: 30007001, total_value: 2_500_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 7001, victim_corporation_id: 6001, victim_alliance_id: 7701, final_blow_character_id: 9001, final_blow_corporation_id: 4001, final_blow_alliance_id: 9901, attackers: [{ character_id: 9001, corporation_id: 4001, alliance_id: 9901, final_blow: true }], zkb_labels: ['tz:eu'], tz_label: 'eu', location_label: 'nullsec' },
          { activity: 'kills', killmail_id: 3, killmail_time: '2026-03-28T12:00:00Z', solar_system_id: 30007002, total_value: 1_200_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 7002, victim_corporation_id: 6002, victim_alliance_id: 7702, final_blow_character_id: 9002, final_blow_corporation_id: 4001, final_blow_alliance_id: 9901, attackers: [{ character_id: 9002, corporation_id: 4001, alliance_id: 9901, final_blow: true }], zkb_labels: ['tz:eu'], tz_label: 'eu', location_label: 'nullsec' },
          { activity: 'kills', killmail_id: 4, killmail_time: '2026-03-27T12:00:00Z', solar_system_id: 30000142, total_value: 500_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 7003, victim_corporation_id: 6003, victim_alliance_id: 7703, final_blow_character_id: 9002, final_blow_corporation_id: 4001, final_blow_alliance_id: 9901, attackers: [{ character_id: 9002, corporation_id: 4001, alliance_id: 9901, final_blow: true }], zkb_labels: ['tz:eu'], tz_label: 'eu', location_label: 'highsec' },
        ];
      }
      return [
        { activity: 'losses', killmail_id: 1, killmail_time: '2026-03-30T12:00:00Z', solar_system_id: 30007001, total_value: 900_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 9001, victim_corporation_id: 4001, victim_alliance_id: 9901, final_blow_character_id: 8001, final_blow_corporation_id: 5001, final_blow_alliance_id: 8801, attackers: [{ character_id: 8001, corporation_id: 5001, alliance_id: 8801, final_blow: true }], zkb_labels: ['tz:eu'], tz_label: 'eu', location_label: 'nullsec' },
      ];
    });
    esiMocks.callEsiOperation.mockImplementation(async (_db: Database.Database, operation: string, _args: Record<string, unknown>) => {
      if (operation === 'post_universe_names') {
        return {
          ok: true,
          data: [
            { id: 9001, name: 'Pilot One' },
            { id: 9002, name: 'Pilot Two' },
            { id: 4001, name: 'Corp X' },
          ],
        };
      }
      return { ok: false, status: 404, error: 'no mock' };
    });
    llmMocks.createNativeResponse.mockResolvedValue({
      id: 'resp_osint',
      output: [],
      outputText: JSON.stringify({
        intelligence_summary: 'Compact staging cluster around X-70MU in Delve. EU timezone corp with home defense pattern.',
        lifestyle: 'small_gang',
        timezone_assessment: 'EU timezone (UTC+1), active around 12:00 UTC',
        threat_level: 'medium',
        threat_reasoning: 'small gang with regional presence',
        home_confidence: 'high',
        behavioral_patterns: ['staging-cluster', 'home defense in X-70MU'],
        tactical_recommendations: ['engage outside peak hours'],
        alternative_interpretations: ['could still be a hunting pipe'],
        uncertainty: ['killboard-only evidence'],
      }),
      error: null,
      toolSearchPaths: [],
      rawEvents: [],
      usage: null,
    });

    const { executeOsintInferHome } = await import('../../src/eve-osint/inference.js');
    const result = await executeOsintInferHome(db, {
      scope: 'corporation',
      id: 4001,
      window_days: 30,
      include_member_analysis: true,
      include_graph: true,
      include_llm_pattern_analysis: true,
    });

    expect(result.ok).toBe(true);
    expect(result.entity_name).toBe('Corp X');
    expect(result.hypotheses[0]?.system_name).toBe('X-70MU');
    expect(result.hypotheses[0]?.kind).toBe('home_system');
    expect(result.activity_cluster?.systems).toContain('X-70MU');
    expect(result.member_analysis?.members_analyzed).toBe(2);
    expect(result.member_analysis?.core_members[0]?.character_name).toBe('Pilot One');
    expect((result.llm_pattern_analysis as { intelligence_summary?: string })?.intelligence_summary).toContain('X-70MU');
    expect((result.llm_pattern_analysis as { lifestyle?: string })?.lifestyle).toBe('small_gang');
  });

  it('falls back to deterministic-only output when LLM pattern analysis fails', async () => {
    eveKillMocks.getEntityDetail.mockResolvedValue({ ok: true, data: { name: 'Solo Pilot' } });
    eveKillMocks.getEntityMembers.mockResolvedValue({ ok: true, data: [] });
    zkillMocks.fetchEntityActivityFeed.mockImplementation(async (_db: Database.Database, args: Record<string, unknown>) => {
      if (args.activity === 'kills') {
        return [{ activity: 'kills', killmail_id: 2, killmail_time: '2026-03-29T12:00:00Z', solar_system_id: 30007001, total_value: 120_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 8002, victim_corporation_id: 6002, attackers: [{ character_id: 7001, corporation_id: 5001, final_blow: true }], zkb_labels: ['tz:us'], tz_label: 'us', location_label: 'nullsec' }];
      }
      return [{ activity: 'losses', killmail_id: 1, killmail_time: '2026-03-30T12:00:00Z', solar_system_id: 30007001, total_value: 180_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 7001, victim_corporation_id: 5001, attackers: [{ character_id: 8001, corporation_id: 6001, final_blow: true }], zkb_labels: ['tz:us'], tz_label: 'us', location_label: 'nullsec' }];
    });
    esiMocks.callEsiOperation.mockImplementation(async (_db: Database.Database, operation: string, _args: Record<string, unknown>) => {
      if (operation === 'post_universe_names') {
        return { ok: true, data: [{ id: 7001, name: 'Solo Pilot' }] };
      }
      return { ok: false, status: 404, error: 'no mock' };
    });
    llmMocks.createNativeResponse.mockRejectedValue(new Error('llm offline'));

    const { executeOsintInferHome } = await import('../../src/eve-osint/inference.js');
    const result = await executeOsintInferHome(db, {
      scope: 'character',
      id: 7001,
      window_days: 30,
      include_member_analysis: false,
      include_graph: true,
      include_llm_pattern_analysis: true,
    });

    expect(result.ok).toBe(true);
    expect(result.hypotheses).toHaveLength(1);
    expect(result.llm_pattern_analysis).toBeNull();
    expect(result.uncertainty.length).toBeGreaterThan(0);
  });

  it('prefers repeated regional activity over a single hub spike', async () => {
    eveKillMocks.getEntityDetail.mockResolvedValue({ ok: true, data: { name: 'Corp Y' } });
    eveKillMocks.getEntityMembers.mockResolvedValue({ ok: true, data: [] });
    zkillMocks.fetchEntityActivityFeed.mockImplementation(async (_db: Database.Database, args: Record<string, unknown>) => {
      if (args.activity === 'kills') {
        return [
          { activity: 'kills', killmail_id: 2, killmail_time: '2026-03-29T12:00:00Z', solar_system_id: 30007001, total_value: 600_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 9002, victim_corporation_id: 6002, attackers: [{ character_id: 9201, corporation_id: 8001, final_blow: true }], zkb_labels: ['tz:eu'], tz_label: 'eu', location_label: 'nullsec' },
          { activity: 'kills', killmail_id: 3, killmail_time: '2026-03-28T12:00:00Z', solar_system_id: 30007002, total_value: 700_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 9003, victim_corporation_id: 6003, attackers: [{ character_id: 9202, corporation_id: 8001, final_blow: true }], zkb_labels: ['tz:eu'], tz_label: 'eu', location_label: 'nullsec' },
          { activity: 'kills', killmail_id: 4, killmail_time: '2026-03-27T12:00:00Z', solar_system_id: 30000142, total_value: 900_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 9004, victim_corporation_id: 6004, attackers: [{ character_id: 9203, corporation_id: 8001, final_blow: true }], zkb_labels: ['tz:eu'], tz_label: 'eu', location_label: 'highsec' },
        ];
      }
      return [{ activity: 'losses', killmail_id: 1, killmail_time: '2026-03-30T12:00:00Z', solar_system_id: 30007001, total_value: 500_000_000, attacker_count: 1, is_npc: false, is_solo: false, is_awox: false, ship_type_id: 11, victim_character_id: 9001, victim_corporation_id: 8001, attackers: [{ character_id: 9101, corporation_id: 5001, final_blow: true }], zkb_labels: ['tz:eu'], tz_label: 'eu', location_label: 'nullsec' }];
    });
    esiMocks.callEsiOperation.mockImplementation(async (_db: Database.Database, operation: string, _args: Record<string, unknown>) => {
      if (operation === 'post_universe_names') {
        return { ok: true, data: [] };
      }
      return { ok: false, status: 404, error: 'no mock' };
    });

    const { executeOsintInferHome } = await import('../../src/eve-osint/inference.js');
    const result = await executeOsintInferHome(db, {
      scope: 'corporation',
      id: 8001,
      window_days: 30,
      include_member_analysis: false,
      include_graph: true,
      include_llm_pattern_analysis: false,
    });

    expect(result.ok).toBe(true);
    expect(result.hypotheses[0]?.system_name).toBe('X-70MU');
  });
});
