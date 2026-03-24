import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

process.env.ALLOWED_TELEGRAM_USER_ID = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.EVE_CLIENT_ID = 'test';
process.env.EVE_CLIENT_SECRET = 'test';
process.env.DEFAULT_MARKET_REGION_ID = '10000002';
process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';

const callEsiOperationMock = vi.fn();
const getLinkedCharacterMock = vi.fn();

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

vi.mock('../../src/eve/sso.js', () => ({
  getLinkedCharacter: getLinkedCharacterMock,
}));

let db: Database.Database;

beforeEach(() => {
  vi.resetAllMocks();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  db.prepare(`INSERT INTO sde_categories (category_id, name, data_json) VALUES (?, ?, ?)`).run(
    6, 'Ship', JSON.stringify({ category_id: 6, name: 'Ship' }),
  );
  db.prepare(`INSERT INTO sde_categories (category_id, name, data_json) VALUES (?, ?, ?)`).run(
    7, 'Module', JSON.stringify({ category_id: 7, name: 'Module' }),
  );
  db.prepare(`INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)`).run(
    898, 'Cruiser', 6, JSON.stringify({ group_id: 898, name: 'Cruiser', category_id: 6 }),
  );
  db.prepare(`INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)`).run(
    602, 'Shield Hardener', 7, JSON.stringify({ group_id: 602, name: 'Shield Hardener', category_id: 7 }),
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    17715,
    'Gila',
    898,
    JSON.stringify({ type_id: 17715, name: 'Gila', group_id: 898, basePrice: 250000000 }),
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    2281,
    'Multispectrum Shield Hardener II',
    602,
    JSON.stringify({ type_id: 2281, name: 'Multispectrum Shield Hardener II', group_id: 602, basePrice: 1200000 }),
  );
  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
    10000002, 'The Forge', JSON.stringify({ region_id: 10000002, name: 'The Forge' }),
  );
  db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
    20000020, 'Kimotoro', 10000002, JSON.stringify({ constellation_id: 20000020, name: 'Kimotoro', region_id: 10000002 }),
  );
  db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
    30000142, 'Jita', 20000020, JSON.stringify({ system_id: 30000142, name: 'Jita', constellation_id: 20000020, security: 0.946 }),
  );
  db.prepare(`INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)`).run(
    'invFlags', '19', 'Mid Slot 0', JSON.stringify({ _key: 19, name: { en: 'Mid Slot 0' } }),
  );
  db.prepare(`INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)`).run(
    'invFlags', '11', 'Cargo', JSON.stringify({ _key: 11, name: { en: 'Cargo' } }),
  );

  getLinkedCharacterMock.mockReturnValue({ characterId: 2116626188 });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ([
      {
        killmail_id: 1001,
        zkb: {
          hash: 'hash-a',
          locationID: 60003760,
          totalValue: 255500000,
          points: 12,
          npc: false,
          solo: true,
          awox: false,
          labels: ['tz:eu', 'solo', 'pvp', 'loc:highsec'],
        },
      },
      {
        killmail_id: 1002,
        zkb: {
          hash: 'hash-b',
          locationID: 60003760,
          totalValue: 199000000,
          points: 9,
          npc: false,
          solo: false,
          awox: false,
          labels: ['tz:eu', 'pvp', 'loc:highsec'],
        },
      },
    ]),
  })) as typeof fetch);

  callEsiOperationMock.mockImplementation(async (_db, operation, args) => {
    if (operation === 'get_killmails_killmail_id_killmail_hash') {
      return {
        ok: true,
        status: 200,
        cached: false,
        headers: {},
        data: buildKillmailDetail(Number((args as Record<string, unknown>).killmail_id)),
      };
    }
    if (operation === 'get_markets_prices') {
      return {
        ok: true,
        status: 200,
        cached: false,
        headers: {},
        data: [
          { type_id: 17715, average_price: 250000000, adjusted_price: 240000000 },
          { type_id: 2281, average_price: 1200000, adjusted_price: 1100000 },
        ],
      };
    }
    if (operation === 'get_characters_character_id') {
      return {
        ok: true,
        status: 200,
        cached: false,
        headers: {},
        data: { character_id: 9001, name: 'Pilot One', security_status: 3.2, corporation_id: 98000001, alliance_id: 99000001 },
      };
    }
    if (operation === 'get_corporations_corporation_id') {
      return {
        ok: true,
        status: 200,
        cached: false,
        headers: {},
        data: { corporation_id: 98000001, name: 'Danger Corp', ticker: 'DANG' },
      };
    }
    if (operation === 'get_alliances_alliance_id') {
      return {
        ok: true,
        status: 200,
        cached: false,
        headers: {},
        data: { alliance_id: 99000001, name: 'Alliance Prime', ticker: 'PRME' },
      };
    }
    return { ok: false, status: 404, error: `Unexpected operation: ${operation}` };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

function buildKillmailDetail(killmailId: number) {
  return {
    killmail_id: killmailId,
    killmail_time: `2026-03-16T10:0${killmailId - 1000}:00Z`,
    solar_system_id: 30000142,
    victim: {
      character_id: 9001,
      corporation_id: 98000001,
      alliance_id: 99000001,
      ship_type_id: 17715,
      damage_taken: 5000,
      items: [
        { item_type_id: 2281, flag: 19, quantity_destroyed: 1 },
        { item_type_id: 2281, flag: 11, quantity_dropped: 1 },
      ],
    },
    attackers: [
      {
        character_id: 9001,
        corporation_id: 98000001,
        alliance_id: 99000001,
        damage_done: 5000,
        final_blow: true,
        security_status: 3.2,
        ship_type_id: 17715,
      },
    ],
  };
}

describe('zKillboard tools', () => {
  it('returns detailed recent system kills with zKill + ESI enrichment', async () => {
    const { executeZkillTool } = await import('../../src/eve/zkill.js');
    const result = await executeZkillTool(
      db,
      'zkill_system_recent_kills',
      {
        system_id: 30000142,
        filter: 'kills',
        past_seconds: 7200,
        limit: 2,
        detail_limit: 2,
      },
      123,
    );

    expect(result.ok).toBe(true);
    expect(result.source).toBe('zkillboard+esi');
    expect((result.summary as { killmail_count: number }).killmail_count).toBe(2);
    expect(((result.summary as { top_systems: Array<{ name: string }> }).top_systems)[0]?.name).toBe('Jita');
    expect((result.killmails as Array<Record<string, unknown>>)).toHaveLength(2);
    expect((((result.killmails as Array<Record<string, any>>)[0]).victim.ship)).toBe('Gila');
  });

  it('builds observed fit meta from ship loss killmails', async () => {
    const { executeZkillTool } = await import('../../src/eve/zkill.js');
    const result = await executeZkillTool(
      db,
      'zkill_ship_loss_fits',
      {
        ship_type_id: 17715,
        past_seconds: 86400,
        limit: 2,
        detail_limit: 2,
      },
      123,
    );

    expect(result.ok).toBe(true);
    expect(result.source).toBe('zkillboard+esi');
    expect((result.total_matches as number)).toBe(2);
    expect((result.sample_ship_name as string)).toBe('Gila');
    const fitMeta = result.fit_meta as { ship_name: string; top_modules_by_slot: { mid_slots: Array<{ name: string; count: number }> } };
    expect(fitMeta.ship_name).toBe('Gila');
    expect(fitMeta.top_modules_by_slot.mid_slots[0]?.name).toBe('Multispectrum Shield Hardener II');
  });
});
