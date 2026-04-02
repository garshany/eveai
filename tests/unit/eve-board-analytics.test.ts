import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { buildRouteThreatDigest, buildSystemDigest } from '../../src/eve-board/analytics.js';

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
      expect(digest.recentKills[0]?.ageMinutes).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('builds tactical route state for nearby gate activity', () => {
    const digest = buildRouteThreatDigest(
      'Dodixie',
      0,
      4,
      'Dodixie',
      'Jita',
      [{
        systemId: 30002659,
        systemName: 'Dodixie',
        systemSec: 0.9,
        jumpsFromPilot: 0,
        threatLevel: 'LOW',
        reason: 'тихо',
        killVelocity: 0,
        jumpSpike: null,
        gateKills: [],
        gankerCount: 0,
        recentKills: [],
      }, {
        systemId: 30002660,
        systemName: 'Uedama',
        systemSec: 0.5,
        jumpsFromPilot: 1,
        threatLevel: 'MEDIUM',
        reason: 'замечена активность у гейта',
        killVelocity: 0.3,
        jumpSpike: null,
        gateKills: [{
          systemId: 30002660,
          systemName: 'Uedama',
          stargateId: 5001,
          connectedSystemName: 'Jita',
          killCount: 2,
          recentKills: 1,
        }],
        gankerCount: 2,
        recentKills: [{
          time: '16:20',
          ageMinutes: 4,
          victimShip: 'Badger',
          victimName: 'Pilot',
          attackerShip: '?',
          attackerName: 'Ganker',
          attackerCount: 2,
          valueMISK: 120,
          solo: false,
        }],
      }, {
        systemId: 30000142,
        systemName: 'Jita',
        systemSec: 0.9,
        jumpsFromPilot: 2,
        threatLevel: 'LOW',
        reason: 'тихо',
        killVelocity: 0,
        jumpSpike: null,
        gateKills: [],
        gankerCount: 0,
        recentKills: [],
      }],
      [],
    );

    expect(digest.tactical.state).toBe('CAMP_LIKELY');
    expect(digest.tactical.zoneRisk.transit).toBe('MEDIUM');
    expect(digest.tactical.zoneRisk.destination).toBe('LOW');
    expect(digest.tactical.headline).toContain('кемп');
  });
});
