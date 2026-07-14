import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  enrichKillmailDetail,
  enrichKillmailReferenceList,
  type KillmailDeps,
} from '../../src/eve/killmail.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  db.prepare(`INSERT INTO sde_categories (category_id, name, data_json) VALUES (?, ?, ?)`).run(
    6, 'Ship', JSON.stringify({ category_id: 6, name: 'Ship' })
  );
  db.prepare(`INSERT INTO sde_categories (category_id, name, data_json) VALUES (?, ?, ?)`).run(
    7, 'Module', JSON.stringify({ category_id: 7, name: 'Module' })
  );
  db.prepare(`INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)`).run(
    898, 'Black Ops', 6, JSON.stringify({ group_id: 898, name: 'Black Ops', category_id: 6 })
  );
  db.prepare(`INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)`).run(
    506, 'Torpedo Launcher', 7, JSON.stringify({ group_id: 506, name: 'Torpedo Launcher', category_id: 7 })
  );
  db.prepare(`INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)`).run(
    83, 'Torpedo', 7, JSON.stringify({ group_id: 83, name: 'Torpedo', category_id: 7 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    44996,
    'Marshal',
    898,
    JSON.stringify({ type_id: 44996, name: 'Marshal', group_id: 898, basePrice: 795900000 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    6001,
    'Torpedo Launcher II',
    506,
    JSON.stringify({ type_id: 6001, name: 'Torpedo Launcher II', group_id: 506, basePrice: 1500000 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    6002,
    'Nova Torpedo',
    83,
    JSON.stringify({ type_id: 6002, name: 'Nova Torpedo', group_id: 83, basePrice: 800 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    7001,
    'Purifier',
    898,
    JSON.stringify({ type_id: 7001, name: 'Purifier', group_id: 898, basePrice: 22000000 })
  );

  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
    10000002, 'The Forge', JSON.stringify({ region_id: 10000002, name: 'The Forge' })
  );
  db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
    20000020, 'Kimotoro', 10000002, JSON.stringify({ constellation_id: 20000020, name: 'Kimotoro', region_id: 10000002 })
  );
  db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
    30000142, 'Jita', 20000020, JSON.stringify({ system_id: 30000142, name: 'Jita', constellation_id: 20000020, security: 0.946 })
  );

  db.prepare(`INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)`).run(
    'invFlags', '27', 'Hi Slot 0', JSON.stringify({ _key: 27, name: { en: 'Hi Slot 0' } })
  );
  db.prepare(`INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)`).run(
    'invFlags', '11', 'Cargo', JSON.stringify({ _key: 11, name: { en: 'Cargo' } })
  );
});

afterEach(() => {
  db.close();
});

function buildDeps(): KillmailDeps {
  const fetchJson = vi.fn(async (_profile: string, command: string, args: string[]) => {
    const id = Number(args[1]);
    if (command === 'characters_character_id') {
      if (id === 9001) {
        return { character_id: 9001, name: 'Killer One', security_status: 4.2, corporation_id: 98000001, alliance_id: 99000001 };
      }
      if (id === 9101) {
        return { character_id: 9101, name: 'Victim One', security_status: -1.5, corporation_id: 98000002, alliance_id: 99000002 };
      }
    }
    if (command === 'corporations_corporation_id') {
      if (id === 98000001) return { corporation_id: 98000001, name: 'Killers Inc', ticker: 'KILL' };
      if (id === 98000002) return { corporation_id: 98000002, name: 'Victims Ltd', ticker: 'RIP' };
    }
    if (command === 'alliances_alliance_id') {
      if (id === 99000001) return { alliance_id: 99000001, name: 'Murder Coalition', ticker: 'MURD' };
      if (id === 99000002) return { alliance_id: 99000002, name: 'Carebear Union', ticker: 'CARE' };
    }
    if (command === 'killmails_killmail_id_killmail_hash') {
      return buildKillmail();
    }
    return null;
  });

  return {
    fetchJson,
    getMarketPrices: vi.fn(async () => new Map([
      [44996, { average_price: 1200000000, adjusted_price: 1100000000 }],
      [6001, { average_price: 2000000, adjusted_price: 1800000 }],
      [6002, { average_price: 1000, adjusted_price: 900 }],
      [7001, { average_price: 25000000, adjusted_price: 22000000 }],
    ])),
  };
}

function buildKillmail(): Record<string, unknown> {
  return {
    killmail_id: 1,
    killmail_time: '2026-03-15T12:00:00Z',
    solar_system_id: 30000142,
    victim: {
      character_id: 9101,
      corporation_id: 98000002,
      alliance_id: 99000002,
      ship_type_id: 44996,
      damage_taken: 5000,
      position: { x: 10.5, y: -20.25, z: 30.75 },
      items: [
        { item_type_id: 6001, flag: 27, quantity_destroyed: 1 },
        { item_type_id: 6002, flag: 11, quantity_dropped: 200 },
      ],
    },
    attackers: [
      {
        character_id: 9001,
        corporation_id: 98000001,
        alliance_id: 99000001,
        damage_done: 5000,
        final_blow: true,
        security_status: 4.2,
        ship_type_id: 7001,
        weapon_type_id: 6001,
      },
    ],
  };
}

describe('killmail enrichment', () => {
  it('enriches detailed killmail with names, fit, location and prices', async () => {
    const enriched = await enrichKillmailDetail(db, buildKillmail(), buildDeps(), { linkedCharacterId: 9101 });

    expect(enriched.source).toBe('esi');
    expect(enriched.linked_character_role).toBe('victim');
    expect((enriched.location as { name: string }).name).toBe('Jita');
    expect(((enriched.location as { region: { name: string } }).region).name).toBe('The Forge');
    expect(((enriched.victim as { character_name: string }).character_name)).toBe('Victim One');
    expect(((enriched.victim as { position: { x: number; y: number; z: number } }).position)).toEqual({
      x: 10.5,
      y: -20.25,
      z: 30.75,
    });
    expect((((enriched.attackers as Array<Record<string, unknown>>)[0]).character_name)).toBe('Killer One');
    expect((((enriched.attackers as Array<Record<string, unknown>>)[0]).ship as { name: string }).name).toBe('Purifier');
    expect((((enriched.victim as { fit: { high_slots: unknown[] } }).fit).high_slots)).toHaveLength(1);
    expect((((enriched.victim as { fit: { cargo: unknown[] } }).fit).cargo)).toHaveLength(1);
    expect((((enriched.summary as { estimated_total_value: number }).estimated_total_value))).toBe(1202200000);
    expect((((enriched.victim as Record<string, any>).ship).links.show_info)).toBe('<url=showinfo:44996>Marshal</url>');
    expect((((enriched.victim as Record<string, any>).ship).ui_actions.open_market_details.args)).toEqual(['--type_id', '44996']);
    expect((((enriched.victim as Record<string, any>).items[0]).links.show_info)).toBe('<url=showinfo:6001>Torpedo Launcher II</url>');
    expect((((enriched.victim as Record<string, any>).items[0]).ui_actions.open_market_details.command)).toBe('ui_openwindow_marketdetails');
    expect((((enriched.attackers as Array<Record<string, any>>)[0]).ui_actions.open_information.command)).toBe('ui_openwindow_information');
    expect((((enriched.attackers as Array<Record<string, any>>)[0]).ui_actions.open_information.args)).toEqual(['--target_id', '9001']);
  });

  it('expands recent killmail refs into detailed ESI summaries', async () => {
    const refs = [{ killmail_id: 1, killmail_hash: 'abc' }];
    const enriched = await enrichKillmailReferenceList(db, refs, buildDeps(), { linkedCharacterId: 9101 });

    expect(enriched.kind).toBe('killmail_reference_list');
    expect(enriched.total_refs).toBe(1);
    expect((enriched.killmails as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(((enriched.killmails as Array<Record<string, unknown>>)[0]).linked_character_role).toBe('victim');
    expect(((((enriched.killmails as Array<Record<string, any>>)[0]).victim).ship).links.show_info).toBe('<url=showinfo:44996>Marshal</url>');
    expect((enriched.remaining_refs as unknown[])).toHaveLength(0);
  });
});
