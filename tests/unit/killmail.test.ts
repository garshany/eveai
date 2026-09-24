import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  enrichKillmailDetail,
  resolveUniverseNames,
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
    if (command === 'post_universe_names') {
      const known: Record<number, string> = {
        9001: 'Killer One',
        9101: 'Victim One',
        98000001: 'Killers Inc',
        98000002: 'Victims Ltd',
        99000001: 'Murder Coalition',
        99000002: 'Carebear Union',
      };
      const ids = JSON.parse(args[1]) as number[];
      return ids.filter((entry) => known[entry]).map((entry) => ({ id: entry, name: known[entry], category: 'character' }));
    }
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

  it('resolves a 300-pilot killmail with batched post_universe_names instead of per-character GETs', async () => {
    const attackers = Array.from({ length: 300 }, (_, index) => ({
      character_id: 2_000_000_000 + index,
      corporation_id: 98_100_000 + (index % 40),
      alliance_id: 99_100_000 + (index % 15),
      damage_done: 10,
      final_blow: index === 0,
      ship_type_id: 7001,
    }));
    const killmail = { ...buildKillmail(), attackers };
    const calls: Array<{ command: string; args: string[] }> = [];
    const deps: KillmailDeps = {
      fetchJson: vi.fn(async (_profile: string, command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === 'post_universe_names') {
          const ids = JSON.parse(args[1]) as number[];
          return ids.map((id) => ({ id, name: `Name ${id}`, category: 'character' }));
        }
        if (command === 'corporations_corporation_id' || command === 'alliances_alliance_id') {
          return { name: 'x', ticker: `T${args[1]}` };
        }
        throw new Error(`unexpected ESI call ${command}`);
      }),
      getMarketPrices: vi.fn(async () => new Map()),
    };

    const enriched = await enrichKillmailDetail(db, killmail, deps);

    expect(calls.filter((call) => call.command === 'characters_character_id')).toHaveLength(0);
    expect(calls.filter((call) => call.command === 'post_universe_names')).toHaveLength(1);
    expect(calls.length).toBeLessThanOrEqual(1 + 2 * 12);
    const namesIds = JSON.parse(calls.find((call) => call.command === 'post_universe_names')!.args[1]) as number[];
    expect(new Set(namesIds).size).toBe(namesIds.length);
    const first = (enriched.attackers as Array<Record<string, unknown>>)[0];
    expect(first.character_name).toBe('Name 2000000000');
    expect(first.corporation_name).toBe('Name 98100000');
    expect(first.alliance_name).toBe('Name 99100000');
    expect((enriched.victim as Record<string, unknown>).corporation_ticker).toBe('T98000002');
  });

  it('keeps enriching when name resolution fails and isolates invalid ids after an ESI 404', async () => {
    const invalidId = 123;
    let namesCalls = 0;
    const deps: Pick<KillmailDeps, 'fetchJson'> = {
      fetchJson: vi.fn(async (_profile: string, command: string, args: string[]) => {
        if (command !== 'post_universe_names') return null;
        namesCalls += 1;
        const ids = JSON.parse(args[1]) as number[];
        if (ids.includes(invalidId)) return null; // ESI 404: whole request rejected
        return ids.map((id) => ({ id, name: `N${id}` }));
      }),
    };
    const ids = [invalidId, ...Array.from({ length: 1500 }, (_, index) => 90_000_000 + index), 90_000_000];
    const names = await resolveUniverseNames(deps, ids);

    expect(names.size).toBe(1500);
    expect(names.has(invalidId)).toBe(false);
    expect(namesCalls).toBeLessThanOrEqual(40);

    const throwingDeps: KillmailDeps = {
      fetchJson: vi.fn(async () => {
        throw new Error('ESI down');
      }),
      getMarketPrices: vi.fn(async () => new Map()),
    };
    const enriched = await enrichKillmailDetail(db, buildKillmail(), throwingDeps);
    expect((enriched.victim as Record<string, unknown>).character_name).toBeNull();
    expect((enriched.attackers as Array<Record<string, unknown>>)).toHaveLength(1);

    // An outage (thrown transport error) is not bisected through: one call, then stop.
    const outage = vi.fn(async () => {
      throw new Error('ESI down');
    });
    const bigSet = Array.from({ length: 1500 }, (_, index) => 90_000_000 + index);
    expect((await resolveUniverseNames({ fetchJson: outage }, bigSet)).size).toBe(0);
    expect(outage).toHaveBeenCalledTimes(1);
  });
});
