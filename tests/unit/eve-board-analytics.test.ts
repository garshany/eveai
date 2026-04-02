import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { buildSystemDigest } from '../../src/eve-board/analytics.js';

describe('eve-board analytics', () => {
  it('attributes live kills to the nearest stargate when killmail positions are present', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    try {
      db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
        10000002,
        'The Forge',
        JSON.stringify({ region_id: 10000002, name: 'The Forge' }),
      );
      db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
        20000389,
        'Kimotoro',
        10000002,
        JSON.stringify({ constellation_id: 20000389, name: 'Kimotoro', region_id: 10000002 }),
      );
      db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
        30002660,
        'Uedama',
        20000389,
        JSON.stringify({ securityStatus: 0.5 }),
      );
      db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
        30000142,
        'Jita',
        20000389,
        JSON.stringify({ securityStatus: 0.9 }),
      );
      db.prepare(
        `INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        50000001,
        30002660,
        30000142,
        50000002,
        JSON.stringify({ position: { x: 10, y: 20, z: 30 } }),
      );

      const digest = buildSystemDigest(
        30002660,
        'Uedama',
        0.5,
        1,
        'LOW',
        'единичные киллы',
        [{
          killmail_id: 134440041,
          killmail_time: '2026-04-02T16:20:00Z',
          ship_name: 'Catalyst',
          victim_character_name: 'Victim One',
          final_blow_character_name: 'Osmon Queen',
          total_value: 42_000_000,
          attacker_count: 1,
          is_solo: false,
          position: { x: 10, y: 20, z: 30 },
        }],
        null,
        0,
        db,
      );

      expect(digest.gateKills).toHaveLength(1);
      expect(digest.gateKills[0]?.connectedSystemName).toBe('Jita');
      expect(digest.gateKills[0]?.killCount).toBe(1);
    } finally {
      db.close();
    }
  });
});
