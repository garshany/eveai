import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const callEsiOperationMock = vi.fn();

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
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

  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('systemID/30000011')) {
      return {
        ok: true,
        json: async () => [{
          killmail_id: 555001,
          zkb: { hash: 'hash-555001', totalValue: 25000000, npc: false, solo: false },
        }],
      };
    }
    return { ok: true, json: async () => [] };
  }));

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
