import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const callEsiOperationMock = vi.fn();
const { buildRouteThreatSnapshotMock } = vi.hoisted(() => ({
  buildRouteThreatSnapshotMock: vi.fn(),
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

vi.mock('../../src/eve-board/route-snapshot.js', () => ({
  buildRouteThreatSnapshot: buildRouteThreatSnapshotMock,
}));

let db: Database.Database;

beforeEach(() => {
  vi.resetAllMocks();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
    1,
    'Region',
    JSON.stringify({ region_id: 1, name: 'Region' }),
  );
  db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
    1,
    'Constellation',
    1,
    JSON.stringify({ constellation_id: 1, region_id: 1, name: 'Constellation' }),
  );

  for (let index = 1; index <= 11; index += 1) {
    db.prepare(
      `INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`,
    ).run(
      30000000 + index,
      `Route ${index}`,
      1,
      JSON.stringify({ securityStatus: 0.9 }),
    );
  }

  const killmailTime = new Date().toISOString();
  buildRouteThreatSnapshotMock.mockResolvedValue({
    routeSystems: Array.from({ length: 11 }, (_, index) => 30000001 + index),
    systems: [{
      systemId: 30000011,
      routeIndex: 10,
      name: 'Route 11',
      sec: 0.9,
      pvpKills: 1,
      npcKills: 0,
      totalValueM: 25,
      valueResolvedKills: 1,
      recentKills: [{
        killmail_id: 555001,
        killmail_time: killmailTime,
        total_value: 25_000_000,
        attacker_count: 1,
        is_npc: false,
        is_solo: true,
        victim_character_id: 9001,
        final_blow_character_id: 9002,
        eve_kill_url: 'https://eve-kill.com/kill/555001',
        time_msk: killmailTime,
      }],
      gateKills: [],
    }],
    jumpMap: new Map(),
    totalKills: 1,
    totalValueM: 25,
    truncated: false,
    requestCount: 1,
    error: null,
    scannedAt: killmailTime,
  });

  callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string) => {
    if (operation === 'get_killmails_killmail_id_killmail_hash') {
      return {
        ok: true,
        data: {
          killmail_time: '2026-04-02T10:00:00Z',
          victim: { character_id: 9001 },
          attackers: [{ character_id: 9002, final_blow: true }],
        },
      };
    }

    if (operation === 'get_universe_system_jumps') {
      return { ok: true, data: [] };
    }

    return { ok: false, error: `unexpected op ${operation}` };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('eve-board briefing', () => {
  it('scans the full selected route instead of dropping tail systems', async () => {
    const { generateBriefing } = await import('../../src/eve-board/briefing.js');

    const routeSystems = Array.from({ length: 11 }, (_, index) => 30000001 + index);
    const text = await generateBriefing(db, routeSystems, 'Route 1', 'Route 11', 1, 0);

    expect(text).toContain('Предполет');
    expect(text).toContain('Впереди:');
    expect(text).toContain('Route 11');
    expect(text).not.toContain('PvP активности не обнаружено');
  });
});
