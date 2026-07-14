import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import type { NormalizedKillmail } from '../../src/eve-kill/types.js';

const routeSnapshotMocks = vi.hoisted(() => ({
  callEsi: vi.fn(),
  getDetail: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: routeSnapshotMocks.callEsi,
}));

vi.mock('../../src/eve-kill/client.js', () => ({
  eveKillKillmailUrl: (id: number) => `https://eve-kill.com/kill/${id}`,
  getKillmailDetail: routeSnapshotMocks.getDetail,
  searchKillmails: routeSnapshotMocks.search,
}));

import { enrichRouteKillmail } from '../../src/eve-board/route-snapshot.js';

let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO sde_groups (group_id, name, data_json) VALUES (?, ?, ?)')
    .run(28, 'Industrial', '{}');
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(648, 'Badger', 28, '{}');
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(603, 'Merlin', 28, '{}');
});

afterEach(() => {
  db.close();
});

describe('route snapshot enrichment', () => {
  it('uses only official CCP ESI victim.position when an id/hash pair is available', async () => {
    const base = killmail({ position: { x: 1, y: 2, z: 3 } });
    routeSnapshotMocks.getDetail.mockResolvedValue({
      ok: true,
      data: killmail({
        sourceShape: 'detail',
        position: { x: 10, y: 20, z: 30 },
        victim: {
          characterId: 90_000_001,
          shipTypeId: 648,
          shipName: 'Stale third-party ship label',
          shipGroupName: 'Stale third-party group label',
          characterName: 'Stale third-party victim name',
        },
        attackers: [{
          characterId: 90_000_002,
          shipTypeId: 603,
          shipName: 'Stale attacker ship label',
          characterName: 'Stale third-party attacker name',
          finalBlow: true,
        }],
      }),
    });
    routeSnapshotMocks.callEsi
      .mockResolvedValueOnce({
        ok: true,
        data: {
          killmail_time: '2026-07-13T12:00:00Z',
          victim: {
            character_id: 90_000_001,
            ship_type_id: 648,
            position: { x: 100, y: 200, z: 300 },
          },
          attackers: [{ character_id: 90_000_002, ship_type_id: 603, final_blow: true }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [
          { id: 90_000_001, name: 'Official victim' },
          { id: 90_000_002, name: 'Official attacker' },
        ],
      });

    const result = await enrichRouteKillmail(db, base);

    expect(result.position).toEqual({ x: 100, y: 200, z: 300 });
    expect(result.ship_name).toBe('Badger');
    expect(result.ship_group_name).toBe('Industrial');
    expect(result.final_blow_ship_name).toBe('Merlin');
    expect(result.victim_character_name).toBe('Official victim');
    expect(result.final_blow_character_name).toBe('Official attacker');
    expect(routeSnapshotMocks.callEsi).toHaveBeenNthCalledWith(
      1,
      db,
      'get_killmails_killmail_id_killmail_hash',
      { killmail_id: 9_001, killmail_hash: 'hash-9001' },
    );
    expect(routeSnapshotMocks.callEsi).toHaveBeenNthCalledWith(
      2,
      db,
      'post_universe_names',
      { ids: '[90000001,90000002]' },
    );
  });

  it('does not trust EVE-KILL coordinates when official ESI detail is unavailable', async () => {
    const base = killmail({ position: { x: 1, y: 2, z: 3 } });
    routeSnapshotMocks.getDetail.mockResolvedValue({
      ok: true,
      data: killmail({
        sourceShape: 'detail',
        position: { x: 10, y: 20, z: 30 },
      }),
    });
    routeSnapshotMocks.callEsi.mockResolvedValue({ ok: false, error: 'official detail unavailable' });

    const result = await enrichRouteKillmail(db, base);

    expect(result.position).toBeUndefined();
  });
});

function killmail(overrides: Partial<NormalizedKillmail> = {}): NormalizedKillmail {
  return {
    killmailId: 9_001,
    killmailHash: 'hash-9001',
    killmailTime: '2026-07-13T12:00:00Z',
    solarSystemId: 30_000_142,
    attackerCount: 0,
    isNpc: false,
    victim: { shipTypeId: 648 },
    attackers: [],
    items: [],
    siblings: [],
    sourceShape: 'feed',
    ...overrides,
  };
}
