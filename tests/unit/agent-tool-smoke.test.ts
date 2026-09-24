import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import {
  DRAKE, FORGE, JITA, JITA_4_4, PERIMETER, PLEX, PYERITE, RIFTER, TAMA, TRITANIUM,
  seedAgentToolSde,
} from '../fixtures/agent-tool-sde.js';

/**
 * Functional smoke for every agent tool: realistic arguments against a small
 * SDE and simulated upstreams (ESI, EVE-KILL REST + MCP, EVE-Scout, Tavily,
 * EVE Uni wiki, EVE Ref, zKillboard, MutaMarket), dispatched through the same
 * executeToolCall path the agent loop uses (policy, admission, validation).
 * Each tool gets one success check and one structured-failure check.
 */

const PROFILE_DIR = vi.hoisted(() => {
  const dir = `/tmp/eveai-agent-tool-smoke-${process.pid}`;
  process.env.USER_PROFILE_PATH = `${dir}/USER_{chat_id}_{character_id}.md`;
  process.env.ESI_CATALOG_CACHE_PATH = './tests/fixtures/esi-swagger.json';
  process.env.OPENAI_PROVIDER = 'modelhub';
  process.env.TAVILY_API_KEY = 'tvly-smoke-test';
  process.env.ESI_RETRY_MAX_ATTEMPTS = '1';
  process.env.ESI_BACKOFF_MAX_SECONDS = '1';
  process.env.EVE_KILL_RETRY_MAX_ATTEMPTS = '1';
  process.env.EVE_KILL_BACKOFF_MAX_MS = '100';
  process.env.COMMUNITY_API_RETRY_MAX_ATTEMPTS = '1';
  process.env.COMMUNITY_API_BACKOFF_MAX_MS = '100';
  process.env.EVE_SCOUT_RETRY_MAX_ATTEMPTS = '1';
  process.env.EVE_SCOUT_BACKOFF_MAX_MS = '100';
  return dir;
});

// ---------------------------------------------------------------------------
// Simulated upstreams. Every outbound request goes through this router; an
// unmatched URL fails the request loudly so a tool cannot pass by accident.
// ---------------------------------------------------------------------------

const NOW = Date.now();
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const HOUR = 3_600_000;
const CHARACTER_ID = 2112000001;
const USER_ID = 1;
const CHAT_ID = 4242;

const failHosts = new Set<string>();
const unmatched: string[] = [];

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(NOW + 300_000).toUTCString(),
      'Cache-Control': 'max-age=300',
      Date: new Date(NOW).toUTCString(),
      ...headers,
    },
  });
}

function summaryKill(id: number, systemId = JITA, offsetMs = -HOUR): Record<string, unknown> {
  return {
    killmail_id: id,
    killmail_time: iso(offsetMs),
    solar_system_id: systemId,
    victim_character_id: 90000001,
    victim_corporation_id: 98000001,
    ship_type_id: RIFTER,
    final_blow_character_id: 90000002,
    attacker_count: 2,
    total_value: 15_000_000,
  };
}

function esiKill(id: number, systemId = JITA, offsetMs = -HOUR): Record<string, unknown> {
  return {
    killmail_id: id,
    killmail_hash: 'a'.repeat(40),
    killmail_time: iso(offsetMs),
    solar_system_id: systemId,
    victim: { character_id: 90000001, corporation_id: 98000001, ship_type_id: RIFTER, damage_taken: 900 },
    attackers: [{ character_id: 90000002, corporation_id: 98000002, ship_type_id: DRAKE, damage_done: 900, final_blow: true }],
  };
}

function mcpResult(payload: unknown): Response {
  return json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
}

function orders(typeId: number): Array<Record<string, unknown>> {
  return [
    { order_id: typeId * 10 + 1, type_id: typeId, is_buy_order: false, price: typeId === TRITANIUM ? 4.1 : 1_000_000, volume_remain: 100_000, volume_total: 100_000, location_id: JITA_4_4, system_id: JITA, min_volume: 1, range: 'region', duration: 90, issued: iso(-HOUR) },
    { order_id: typeId * 10 + 2, type_id: typeId, is_buy_order: true, price: typeId === TRITANIUM ? 3.9 : 900_000, volume_remain: 50_000, volume_total: 50_000, location_id: JITA_4_4, system_id: JITA, min_volume: 1, range: 'station', duration: 90, issued: iso(-HOUR) },
  ];
}

async function routeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (failHosts.has(url.hostname)) return json({ error: 'upstream unavailable' }, 503);
  const path = url.pathname;
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;

  if (url.hostname === 'esi.evetech.net') {
    const p = path.replace(/^\/(latest|v\d+)/, '');
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/markets\/(\d+)\/orders\/?$/))) return json(orders(Number(url.searchParams.get('type_id'))), 200, { 'X-Pages': '1' });
    if (p.match(/^\/markets\/prices\/?$/)) return json([TRITANIUM, PYERITE, RIFTER, DRAKE, PLEX].map((type_id) => ({ type_id, average_price: 1000, adjusted_price: 900 })));
    if ((m = p.match(/^\/markets\/(\d+)\/history\/?$/))) {
      return json(Array.from({ length: 30 }, (_, index) => ({
        date: new Date(NOW - (30 - index) * 24 * HOUR).toISOString().slice(0, 10),
        average: 4 + index / 100, highest: 4.5, lowest: 3.8, order_count: 1000 + index, volume: 1_000_000 + index,
      })));
    }
    if (p.match(/^\/universe\/system_kills\/?$/)) return json([{ system_id: JITA, ship_kills: 3, npc_kills: 10, pod_kills: 1 }, { system_id: TAMA, ship_kills: 12, npc_kills: 0, pod_kills: 5 }]);
    if (p.match(/^\/universe\/system_jumps\/?$/)) return json([{ system_id: JITA, ship_jumps: 2500 }, { system_id: TAMA, ship_jumps: 300 }]);
    if (p.match(/^\/industry\/systems\/?$/)) return json([{ solar_system_id: JITA, cost_indices: [{ activity: 'manufacturing', cost_index: 0.05 }] }]);
    if (p.match(/^\/sovereignty\/map\/?$/)) return json([{ system_id: JITA, faction_id: 500001 }, { system_id: TAMA }]);
    if ((m = p.match(/^\/dogma\/dynamic\/items\/(\d+)\/(\d+)\/?$/))) {
      return json({ created_by: 90000009, source_type_id: 3841, mutator_type_id: 49738,
        dogma_attributes: [{ attribute_id: 72, value: 1520.5 }, { attribute_id: 30, value: 150 }],
        dogma_effects: [{ effect_id: 21, is_default: false }] });
    }
    if ((m = p.match(/^\/route\/(\d+)\/(\d+)\/?$/))) {
      const origin = Number(m[1]);
      const destination = Number(m[2]);
      const flag = url.searchParams.get('flag');
      if (origin === destination) return json([origin]);
      if (destination === TAMA) return json([origin, ...(origin === PERIMETER ? [] : [PERIMETER]), TAMA]);
      return json(flag === 'insecure' ? [origin, destination] : [origin, destination]);
    }
    if (p.match(/^\/universe\/ids\/?$/) && method === 'POST') {
      const names = (body as string[]).map((name) => name.toLowerCase());
      return json({ characters: [
        { id: 90000001, name: 'Prey Pilot' }, { id: 90000002, name: 'Hunter Pilot' },
      ].filter((entry) => names.includes(entry.name.toLowerCase())) });
    }
    if (p.match(/^\/characters\/affiliation\/?$/) && method === 'POST') {
      return json((body as number[]).map((character_id) => ({ character_id, corporation_id: 98000001, alliance_id: 99000001 })));
    }
    if (p.match(/^\/universe\/names\/?$/) && method === 'POST') {
      return json((body as number[]).map((id) => ({ id, name: `Entity ${id}`, category: id >= 99000000 && id < 100000000 ? 'alliance' : id >= 98000000 ? 'corporation' : id >= 90000000 ? 'character' : id >= 30000000 && id < 31000000 ? 'solar_system' : 'inventory_type' })));
    }
    if ((m = p.match(/^\/characters\/(\d+)\/location\/?$/))) return json({ solar_system_id: JITA, station_id: JITA_4_4 });
    if ((m = p.match(/^\/characters\/(\d+)\/ship\/?$/))) return json({ ship_type_id: RIFTER, ship_item_id: 1000000000001, ship_name: 'Smoke Test' });
    if ((m = p.match(/^\/characters\/(\d+)\/online\/?$/))) return json({ online: true });
    if ((m = p.match(/^\/characters\/(\d+)\/assets\/?$/))) {
      return json([
        { item_id: 1000000000001, type_id: RIFTER, quantity: 1, location_id: JITA_4_4, location_flag: 'Hangar', location_type: 'station', is_singleton: true },
        { item_id: 1000000000002, type_id: TRITANIUM, quantity: 1_000_000, location_id: JITA_4_4, location_flag: 'Hangar', location_type: 'station', is_singleton: false },
      ], 200, { 'X-Pages': '1' });
    }
    if ((m = p.match(/^\/characters\/(\d+)\/orders\/?$/))) {
      return json([{ order_id: 7000001, type_id: TRITANIUM, is_buy_order: false, price: 4.2, volume_remain: 10_000, volume_total: 20_000, location_id: JITA_4_4, region_id: FORGE, range: 'region', duration: 90, issued: iso(-HOUR), is_corporation: false, escrow: 0, min_volume: 1 }]);
    }
    if ((m = p.match(/^\/characters\/(\d+)\/wallet\/?$/))) return json(1_234_567.89);
    if ((m = p.match(/^\/characters\/(\d+)\/?$/))) return json({ name: 'Smoke Pilot', corporation_id: 98000001, birthday: '2010-01-01T00:00:00Z', gender: 'male', race_id: 1, bloodline_id: 1, security_status: 1.2 });
    if (p.match(/^\/status\/?$/)) return json({ players: 23456, server_version: '2900000', start_time: iso(-10 * HOUR) });
    if (p.match(/^\/ui\/autopilot\/waypoint\/?$/) && method === 'POST') return new Response(null, { status: 204 });
    if (p.match(/^\/universe\/systems\/(\d+)\/?$/)) return json({ system_id: JITA, name: 'Jita', security_status: 0.9459, constellation_id: 20000020, star_id: 40009076 });
  }

  if (url.hostname === 'api.eve-kill.com') {
    const p = path.replace(/^\/+/, '');
    let m: RegExpMatchArray | null;
    if (p === 'killmails/search' && method === 'POST') {
      const filters = body as { system_ids?: number[]; character_ids?: number[] };
      const kills = [esiKill(130000001, JITA), esiKill(130000002, PERIMETER, -2 * HOUR)]
        .filter((kill) => !filters.system_ids || filters.system_ids.includes(kill.solar_system_id as number));
      return json({ data: kills, pagination: { hasMore: false, cursor: null } });
    }
    if ((m = p.match(/^sde\/systems\/(\d+)\/kills$/))) return json({ data: [summaryKill(130000003, Number(m[1]))], pagination: { hasMore: false, cursor: null } });
    if ((m = p.match(/^(characters|corporations|alliances)\/(\d+)\/(kills|losses)$/))) {
      return json({ data: [summaryKill(m[3] === 'kills' ? 130000004 : 130000005, JITA)], pagination: { hasMore: false, cursor: null } });
    }
    if ((m = p.match(/^killmails\/(\d+)\/esi$/))) return json(esiKill(Number(m[1])));
    if ((m = p.match(/^killmails\/(\d+)\/fitting$/))) {
      return json({ killmail_id: Number(m[1]), ship: { type_id: RIFTER, name: 'Rifter' }, high_slots: [{ type_id: 2873, name: '200mm AutoCannon I', quantity: 1 }], cargo: [] });
    }
    if ((m = p.match(/^killmails\/(\d+)$/))) {
      return json({ killmail_id: Number(m[1]), killmail_time: iso(-HOUR), solar_system_id: JITA, total_value: 15_000_000,
        victim: { character_id: 90000001, ship_type_id: RIFTER, position: { x: 1, y: 2, z: 3 } },
        attackers: [{ character_id: 90000002, final_blow: true }], items: [{ type_id: TRITANIUM, quantity_dropped: 5, quantity_destroyed: 0 }] });
    }
    if ((m = p.match(/^characters\/(\d+)\/stats$/))) {
      return json({ id: Number(m[1]), kills: 42, losses: 3, solo_kills: 10, npc_losses: 0, isk_destroyed: 5e9, isk_lost: 1e8, topShips: [] });
    }
    if (p === 'characters/stats' && method === 'POST') {
      return json({ period: String((body as { type: string }).type), results: (body as { ids: number[] }).ids.map((id) => ({ id, kills: 5, losses: 1, solo_kills: 2, npc_losses: 0, isk_destroyed: 1e9, isk_lost: 1e7, topShips: [] })) });
    }
    if ((m = p.match(/^characters\/(\d+)\/intel$/))) {
      return json({ character_id: Number(m[1]), days: Number(url.searchParams.get('days')),
        playstyle: { solo: 3, small_gang: 1, mid_gang: 0, fleet: 0, blob: 0, avg_fleet_size: 1.5, total_kills: 4 },
        dominant_style: 'Solo', tags: ['solo'], fc: { likelihood: 'None', monitor_appearances: 0 }, capital_pilot: false,
        is_logi: false, ships_flown: [], ships_lost: [], targets: [], fleet_partners: [], groups_flown_with: [],
        awox_kills: 0, cyno_deaths: 0, bait: 'None', bait_count: 0, bridge_score: 0 });
    }
    if (p === 'stats') return json({ entries: [{ id: 90000002, name: 'Hunter Pilot', count: 12, type: 'character' }] });
    if (p === 'battles') {
      return json({ data: [{ battle_id: 555, solar_system_id: JITA, system_name: 'Jita', region_id: FORGE, region_name: 'The Forge', start_time: iso(-3 * HOUR), end_time: iso(-2 * HOUR), duration_minutes: 60, kill_count: 12, total_isk_destroyed: 2e9, is_multi_party: false, is_custom: false }], pagination: { page: 1, limit: 20, hasMore: false } });
    }
    if ((m = p.match(/^battles\/(\d+)$/))) {
      return json({ battle: { battle_id: Number(m[1]), solar_system_id: JITA, system_name: 'Jita', region_id: FORGE, region_name: 'The Forge', start_time: iso(-3 * HOUR), end_time: iso(-2 * HOUR), duration_minutes: 60, kill_count: 12, total_isk_destroyed: 2e9, is_multi_party: false, is_custom: false },
        teams: [{ team_index: 0, total_kills: 6, total_losses: 6, total_isk_destroyed: 1e9, total_isk_lost: 1e9, members: [{ corporation_id: 98000001, corporation_name: 'Corp', corporation_ticker: 'CRP', kills: 6, losses: 6, isk_destroyed: 1e9, isk_lost: 1e9 }] }] });
    }
  }

  if (url.hostname === 'mcp.eve-kill.com') {
    const call = body as { params: { name: string; arguments: Record<string, unknown> } };
    const name = call.params.name;
    if (name === 'doctrine_detect') {
      return mcpResult({
        entity: { id: call.params.arguments.entity, name: 'Smoke Alliance', type: call.params.arguments.type },
        window: { since: call.params.arguments.since ?? iso(-7 * 24 * HOUR), until: call.params.arguments.until ?? iso(0) },
        count: 1,
        clusters: [{ family_hash: 'b'.repeat(64), ship: { type_id: DRAKE, name: 'Drake' }, signature: 'Shield Drake', losses: 4, isk_lost: 4e8, avg_isk_per_loss: 1e8,
          example_killmail: { killmail_id: 130000001, url: 'https://eve-kill.com/kill/130000001', modules: [{ type_id: 3841, name: 'Large Shield Extender II' }] },
          first_loss: iso(-3 * 24 * HOUR), last_loss: iso(-2 * HOUR) }],
      });
    }
    return mcpResult({ tool: name, rows: [{ id: 1, value: 2 }] });
  }

  if (url.hostname === 'api.eve-scout.com') {
    const p = path.replace(/^\/v2\/public\//, '');
    const routeSystem = (id: number, name: string) => ({ system_id: id, system_name: name, region_id: FORGE, region_name: 'The Forge', system_class: 'hs', security_status: 0.9 });
    if (p.startsWith('routes')) {
      return json([{ from: 'Jita', to: 'Thera', jumps: 1, route: [routeSystem(JITA, 'Jita'), { ...routeSystem(31000005, 'Thera'), system_class: 'c12', security_status: -1 }] }]);
    }
    if (p === 'signatures') {
      return json([{ id: '1001', completed: true, wh_type: 'Q063', max_ship_size: 'medium', expires_at: iso(10 * HOUR), remaining_hours: 10,
        in_system_id: JITA, in_system_name: 'Jita', in_system_class: 'hs', in_region_name: 'The Forge', out_system_id: 31000005,
        out_system_name: 'Thera', in_signature: 'ABC-123', out_signature: 'XYZ-789', signature_type: 'wormhole' }]);
    }
    if (p === 'observations') {
      return json([{ id: '2001', created_at: iso(-HOUR), created_by_id: 90000003, created_by_name: 'Scout', observed_in_person: true,
        observation_type: 'electric_storm', observation_category: 'storm', display_name: 'Electric Storm', hours_in_system: 3,
        system_id: TAMA, system_name: 'Tama', region_id: 10000033, region_name: 'The Citadel' }]);
    }
    if (p === 'wormholetypes') {
      const all = ['C140', 'A239', 'K162'].map((identifier, index) => ({ identifier, type_id: 30705 + index, max_jump_mass: 2e9, max_stable_mass: 3.3e9,
        max_stable_time: 1440, mass_regeneration: 0, source: ['c5'], target_system_class: 'ls', possible_static: false, wandering_only: true,
        comment_public: '', signature_level: [1] }));
      const identifier = url.searchParams.get('identifier');
      return json(identifier ? all.filter((row) => row.identifier === identifier) : all);
    }
    if (p === 'systems') {
      return json([{ system_id: 31000005, system_name: 'Thera', system_class: 'c12', region_id: 11000031, region_name: 'G-R00031', security_status: -1 }]);
    }
  }

  if (url.hostname === 'api.tavily.com') {
    return json({ results: [{ title: 'Wormholes - EVE University Wiki', url: 'https://wiki.eveuniversity.org/Wormholes', content: 'Wormholes are unstable...' }] });
  }
  if (url.hostname === 'wiki.eveuniversity.org') {
    return json({ query: { search: [{ title: 'Wormhole attributes', snippet: 'Mass and time limits', pageid: 1 }] } });
  }
  if (url.hostname === 'api.everef.net') {
    return json({ manufacturing: { [String(RIFTER)]: { product_id: RIFTER, runs: 1, total_cost: 450_000, materials: { [String(TRITANIUM)]: { quantity: 32_000 } } } } });
  }
  if (url.hostname === 'zkillboard.com') {
    return json({ dangerRatio: 80, gangRatio: 30, shipsDestroyed: 500, shipsLost: 40, iskDestroyed: 6e10, iskLost: 2e9, soloKills: 120,
      topAllTime: [{ type: 'ship', data: [{ shipTypeID: RIFTER, kills: 200 }] }], activity: { 0: { 18: 5, 19: 7 } } });
  }
  if (url.hostname === 'mutamarket.com') {
    return json({ data: [{ id: 1040000001, type: { name: 'Abyssal Medium Shield Extender' }, contract: { price: 55_000_000, type: 'item_exchange' }, estimated_value: 60_000_000,
      mutated_attributes: [{ name: 'capacityBonus', display_name: 'Shield Hitpoint Bonus', value: 1520, base_value: 1400 }] }] });
  }
  if (url.hostname === 'janice.e-351.com') {
    return json({ immediatePrices: { totalBuyPrice: 1, totalSellPrice: 2 } });
  }

  unmatched.push(`${method} ${url.toString()}`);
  return json({ error: `unmatched ${method} ${url.pathname}` }, 404);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let db: Database.Database;
const ctx = { userId: USER_ID, chatId: CHAT_ID };

let executor: typeof import('../../src/agent/executor.js');
let webSearch: typeof import('../../src/agent/web-search.js');
let mapGraph: typeof import('../../src/eve/map-graph.js');

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await executor.__test__.executeToolCall(
    db as never,
    'req-smoke',
    'smoke test goal',
    ctx as never,
    name,
    args,
    webSearch.createWebSearchState(),
  ) as Record<string, unknown>;
}

function linkCharacter(): void {
  const scopes = [
    'esi-location.read_location.v1', 'esi-location.read_ship_type.v1', 'esi-location.read_online.v1',
    'esi-assets.read_assets.v1', 'esi-markets.read_character_orders.v1', 'esi-wallet.read_character_wallet.v1',
    'esi-ui.write_waypoint.v1',
  ];
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)').run(USER_ID, 'pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)').run(CHAT_ID, 'pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Smoke Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify(scopes), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)').run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function seedMarketSnapshot(): void {
  const insert = db.prepare(`
    INSERT INTO market_orders (order_id, type_id, region_id, system_id, station_id, location_id, is_buy_order, price,
      volume_remain, volume_total, min_volume, duration, range, issued)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 90, 'region', ?)
  `);
  insert.run(1, TRITANIUM, FORGE, JITA, JITA_4_4, JITA_4_4, 0, 4.1, 1_000_000, 1_000_000, iso(-HOUR));
  insert.run(2, TRITANIUM, FORGE, JITA, JITA_4_4, JITA_4_4, 1, 3.9, 500_000, 500_000, iso(-HOUR));
  insert.run(3, PYERITE, FORGE, JITA, JITA_4_4, JITA_4_4, 0, 9.5, 400_000, 400_000, iso(-HOUR));
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(routeFetch));
  executor = await import('../../src/agent/executor.js');
  webSearch = await import('../../src/agent/web-search.js');
  mapGraph = await import('../../src/eve/map-graph.js');
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db as never);
  seedAgentToolSde(db);
  seedMarketSnapshot();
  mapGraph.invalidateMapGraphCache();
  mapGraph.buildMapGraph(db as never, { force: true });
  linkCharacter();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  writeFileSync(`${PROFILE_DIR}/USER_${CHAT_ID}_${CHARACTER_ID}.md`, '# Smoke Pilot\n\n## Active fitting\n\nnone\n');
  failHosts.clear();
  unmatched.length = 0;
  // Private ESI requires a fresh capability check, exactly as in a live turn.
  expect(await call('get_eve_capabilities', { intent: 'smoke test private reads' })).toMatchObject({ authenticated: true });
});

afterEach(() => {
  expect(unmatched, 'every outbound request must hit a simulated upstream').toEqual([]);
  db.close();
  mapGraph.invalidateMapGraphCache();
});

type Row = Record<string, unknown>;
type Case = [name: string, args: Row, check: (result: Row) => void];

const since = (hours: number) => iso(-hours * HOUR);
const recent = iso(-60_000);
const data = (result: Row) => result.data as Row;

const SUCCESS_CASES: Case[] = [
  // Always-on and planning
  ['get_eve_capabilities', { intent: 'check my wallet' }, (r) => {
    expect(r).toMatchObject({ authenticated: true, characterId: CHARACTER_ID });
    expect(r.grantedScopes).toContain('esi-wallet.read_character_wallet.v1');
  }],
  ['web_search', { query: 'wormhole mass limits' }, (r) => {
    expect(r.ok).toBe(true);
    const sources = (r.results as Row[]).map((row) => row.source);
    expect(sources).toEqual(expect.arrayContaining(['Tavily', 'EVE University Wiki']));
  }],
  ['update_plan', { steps: [{ id: 'prices', title: 'Look up Jita prices', status: 'running', depends_on: [], notes: '' }] }, (r) => {
    expect(r).toMatchObject({ requestId: 'req-smoke', steps: [{ id: 'prices', status: 'running' }] });
  }],
  ['count_universe_objects', { target_kind: 'region', target_name: 'The Forge', object_kind: 'systems' }, (r) => {
    expect(r).toMatchObject({ ok: true, count: 4, region_id: FORGE });
  }],
  ['sde_sql', { sql: "SELECT type_id, name FROM sde_types WHERE name IN ('Rifter', 'Drake') ORDER BY type_id" }, (r) => {
    expect(r).toMatchObject({ ok: true, rows: [{ type_id: RIFTER, name: 'Rifter' }, { type_id: DRAKE, name: 'Drake' }] });
  }],
  ['character_sql', { sql: 'SELECT type_id, quantity FROM character_assets ORDER BY quantity DESC' }, (r) => {
    expect(r).toMatchObject({ ok: true, rows: [{ type_id: TRITANIUM, quantity: 1_000_000 }, { type_id: RIFTER, quantity: 1 }] });
  }],
  ['plan_route', { origin: 'Jita', destination: 'Tama', set_autopilot: null, prefer: null }, (r) => {
    expect(r).toMatchObject({ ok: true, origin: { name: 'Jita' }, destination: { name: 'Tama' }, autopilot_set: false });
    expect((r.routes as Row[])[0]).toMatchObject({ jumps: 2 });
  }],
  ['route_monitor', { action: 'status' }, (r) => expect(r).toMatchObject({ ok: true, active: false })],
  ['heartbeat_config', { action: 'enable_check', interval_seconds: null, check: 'wallet' }, (r) => {
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).toContain('wallet');
  }],
  ['intel_note', { action: 'save', text: 'Gate camp on the Perimeter gate', system: 'Jita', region: null, entity_name: null, tag: 'hostile', query: null, note_id: null }, (r) => {
    expect(r).toMatchObject({ ok: true, system: 'Jita', region: 'The Forge', tag: 'hostile' });
  }],
  ['set_active_fit', { fitting: '[Rifter, Smoke]\n200mm AutoCannon I\n200mm AutoCannon I' }, (r) => expect(r).toEqual({ ok: true })],
  // Market and private ESI facades
  ['batch_market_prices', { region_id: FORGE, type_ids: [TRITANIUM, PYERITE] }, (r) => {
    expect(r).toMatchObject({ ok: true, source: 'CCP ESI', prices: [{ type_id: TRITANIUM, sell: { min_price: 4.1 }, buy: { max_price: 3.9 } }, { type_id: PYERITE }] });
  }],
  ['market_wide_summary', { type_id: TRITANIUM }, (r) => {
    expect(r).toMatchObject({ ok: true, type_name: 'Tritanium', best_sell: { price: 4.1, system_name: 'Jita' } });
  }],
  ['assets_summary', { top: 5 }, (r) => {
    expect(r).toMatchObject({ ok: true, coverage: { complete: true, asset_rows: 2 }, totals: { distinct_types: 2 } });
  }],
  ['character_orders_summary', { top: 5 }, (r) => {
    expect(r).toMatchObject({ ok: true, totals: { orders: 1, sell_orders: 1 }, top_sell_orders: [{ type_id: TRITANIUM }] });
  }],
  ['market_history_summary', { region_id: FORGE, type_id: TRITANIUM, days: 30 }, (r) => {
    expect(r).toMatchObject({ ok: true, source: 'CCP ESI' });
    expect(JSON.stringify(r)).toContain('average');
  }],
  ['system_metric_snapshot', { metric: 'kills', system_ids: [JITA, TAMA] }, (r) => {
    expect(r).toMatchObject({ ok: true, rows: [{ system_id: JITA, found: true, ship: 3 }, { system_id: TAMA, ship: 12 }] });
  }],
  ['dynamic_item_summary', { type_id: 47408, item_id: 1040000001, attribute_ids: [72, 30] }, (r) => {
    expect(r).toMatchObject({ ok: true });
    expect(JSON.stringify(r)).toContain('"attribute_id":72');
  }],
  ['appraise_items', { items_text: 'Tritanium 1000\nPyerite x500', region_id: null }, (r) => {
    expect(r).toMatchObject({ ok: true, regionId: FORGE, totals: { itemsPriced: 2, itemsTotal: 2 } });
  }],
  // Intel and scans
  ['osint_infer_home', { scope: 'character', id: 90000002, window_days: 30, include_member_analysis: null, include_graph: null, include_llm_pattern_analysis: null }, (r) => {
    expect(r).toMatchObject({ ok: true, scope: 'character', id: 90000002 });
    expect((r.hypotheses as Row[]).length).toBeGreaterThan(0);
  }],
  ['analyze_local', { pilots: 'Prey Pilot\nHunter Pilot', days: 7 }, (r) => {
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).toContain('Hunter Pilot');
  }],
  ['analyze_scan', { paste: `${RIFTER}\tHunter's Rifter\tRifter\t1,200 km\n${DRAKE}\tDrake\tDrake\t-`, scan_type: null, days: null }, (r) => {
    expect(r).toMatchObject({ ok: true, scan_type: 'dscan', total_objects: 2, resolved: 2 });
  }],
  // Perimeter (call-only: src/eve-map is owned elsewhere)
  ['map_bubble_intel', { system_id: JITA, radius: 2, ship_type_id: RIFTER }, (r) => {
    expect(r).toMatchObject({ ok: true, origin_system_id: JITA });
    expect(r.system_count).toBeGreaterThan(1);
  }],
  ['route_risk', { origin_system_id: JITA, destination_system_id: TAMA, mode: 'secure', risk_weight: 2, draw_on_map: false }, (r) => {
    expect(r).toMatchObject({ ok: true, jumps: 2 });
  }],
  ['compare_ships', { ship_type_id_a: RIFTER, ship_type_id_b: DRAKE }, (r) => {
    expect(r).toMatchObject({ ok: true, comparison: { tougher: 'Drake', faster_align: 'Rifter' } });
  }],
  ['threat_explain', { system_id: JITA }, (r) => expect(r).toMatchObject({ ok: true, system: { name: 'Jita' } })],
  // Community APIs
  ['industry_cost', { product_id: RIFTER, runs: 1, me_level: null, te_level: null }, (r) => {
    expect(r).toMatchObject({ ok: true, source: 'everef.net industry API' });
  }],
  ['pilot_intel', { scope: 'character', id: 90000002 }, (r) => {
    expect(r).toMatchObject({ ok: true, stats: { shipsDestroyed: 500, topShips: [{ shipTypeId: RIFTER }] } });
  }],
  ['abyssal_market', { type_id: 47408 }, (r) => {
    expect(r).toMatchObject({ ok: true, listings: [{ price: 55_000_000 }] });
  }],
  // EVE-KILL
  ['kill_activity_summary', { scope: 'system', id: JITA, activity: 'all', from: since(24), to: recent, evidence_limit: null }, (r) => {
    expect(r).toMatchObject({ ok: true, source: 'EVE-KILL' });
    expect(JSON.stringify(r)).toContain('130000001');
  }],
  ['kill_search', { from: since(6), to: recent, system_ids: [JITA], constellation_ids: null, region_ids: null, character_ids: null, corporation_ids: null, alliance_ids: null, limit: 10 }, (r) => {
    expect(r).toMatchObject({ ok: true, data: { kills: [{ killmail_id: 130000001, solar_system_id: JITA }] } });
  }],
  ['kill_activity', { scope: 'character', id: 90000002, activity: 'all', from: null, to: null, limit: 10 }, (r) => {
    expect(r.ok).toBe(true);
    expect((data(r).kills as Row[]).length).toBe(2);
  }],
  ['kill_detail', { action: 'detail', killmail_id: 130000001 }, (r) => {
    expect(r).toMatchObject({ ok: true, data: { killmail_id: 130000001, items: [{ typeId: TRITANIUM, quantityDropped: 5 }] } });
  }],
  ['kill_intel', { action: 'character_intel', character_id: 90000002, period: null, days: 30, data_type: null, limit: null }, (r) => {
    expect(r).toMatchObject({ ok: true, data: { character_id: 90000002, dominant_style: 'Solo' } });
  }],
  ['kill_battles', { action: 'list', battle_id: null, page: null, limit: 5, sort: null }, (r) => {
    expect(r).toMatchObject({ ok: true, data: { data: [{ battle_id: 555 }] } });
  }],
  ['kill_watch', { action: 'watch', topic_type: 'system', topic_id: JITA, label: 'Jita' }, (r) => {
    expect(r).toMatchObject({ ok: true, topic: `system.${JITA}` });
  }],
  ['doctrine_summary', { entity_id: 99000001, entity_type: 'alliance', from: since(7 * 24), to: recent, top: 3 }, (r) => {
    expect(r).toMatchObject({ ok: true, count: 1, doctrines: [{ ship_name: 'Drake', losses: 4 }] });
    expect(JSON.stringify(r)).not.toContain('Large Shield Extender');
  }],
  ['doctrine_detect', { entity: 99000001, type: 'alliance', since: null, until: null, min_cluster_size: null, include_rookie_ships: null, limit: 5 }, (r) => {
    expect(r).toMatchObject({ ok: true, tool: 'doctrine_detect', data: { count: 1 } });
  }],
  ['meta_pulse', { region_id: FORGE, ship_category: 'frigate', since: null, until: null, min_cluster_size: null, include_rookie_ships: null, limit: 5 }, (r) => {
    expect(r).toMatchObject({ ok: true, tool: 'meta_pulse' });
  }],
  ['killmail_forensics', { killmail_id: 130000001 }, (r) => expect(r).toMatchObject({ ok: true, tool: 'killmail_forensics' })],
  ['coalition_graph', { since: null, until: null, min_edge_weight: null, min_alliance_battles: null, focus_alliance: 99000001, limit_edges: 10 }, (r) => {
    expect(r).toMatchObject({ ok: true, tool: 'coalition_graph' });
  }],
  // EVE-Scout
  ['scout_route', { from: 'Jita', to: 'Thera', destinations: null, preference: null, mode: null }, (r) => {
    expect(r).toMatchObject({ ok: true, routes: [{ jumps: 1 }] });
  }],
  ['compare_wormhole_types', { identifiers: ['C140', 'A239'] }, (r) => {
    expect(r).toMatchObject({ ok: true, wormhole_types: [{ identifier: 'C140', found: true }, { identifier: 'A239', found: true }] });
  }],
  ['scout_signatures', { system_name: 'Jita' }, (r) => expect(r).toMatchObject({ ok: true, count: 1, connections: [{ hub: 'Thera' }] })],
  ['scout_observations', {}, (r) => expect(r).toMatchObject({ ok: true, observations: [{ system: 'Tama' }] })],
  ['scout_wormhole_types', { identifier: 'C140', source: null, target: null }, (r) => {
    expect(r).toMatchObject({ ok: true, count: 1, wormhole_types: [{ identifier: 'C140' }] });
  }],
  ['scout_systems', { query: 'Thera', space: null, limit: 5 }, (r) => {
    expect(r).toMatchObject({ ok: true, systems: [{ system_name: 'Thera', system_class: 'c12' }] });
  }],
  // ESI catalog (public, private, bulk-filtered)
  ['get_status', { fields: ['players'] }, (r) => expect(r).toMatchObject({ ok: true, data: { players: 23456 } })],
  ['get_characters_character_id_wallet', { character_id: null, fields: null }, (r) => expect(r).toMatchObject({ ok: true, data: 1_234_567.89 })],
  ['get_universe_system_kills', { filter_ids: [TAMA], fields: null }, (r) => {
    expect(r).toMatchObject({ ok: true });
    expect(r.data).toEqual([expect.objectContaining({ system_id: TAMA, ship_kills: 12 })]);
  }],
  ['post_universe_names', { ids: JSON.stringify([JITA]) }, (r) => expect(r).toMatchObject({ ok: true, data: [{ id: JITA }] })],
  // Local batch (ModelHub provider)
  ['local_parallel_batch', { calls: [
    { id: 'count', tool: 'count_universe_objects', arguments_json: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: 'systems' }) },
    { id: 'prices', tool: 'batch_market_prices', arguments_json: JSON.stringify({ region_id: FORGE, type_ids: [TRITANIUM] }) },
  ] }, (r) => {
    expect(r).toMatchObject({ ok: true, results: [{ id: 'count', output: { ok: true, count: 4 } }, { id: 'prices', output: { ok: true } }] });
  }],
];

type FailureCase = [name: string, args: Row, failHost: string | null, expected: Row];

const FAILURE_CASES: FailureCase[] = [
  ['get_eve_capabilities', { intent: 'x' }, null, {}],
  ['web_search', { query: 'wormhole' }, 'wiki.eveuniversity.org', { ok: true }],
  ['update_plan', { steps: [] }, null, { steps: [] }],
  ['count_universe_objects', { target_kind: 'region', target_name: 'Nowhere', object_kind: 'systems' }, null, { ok: false, error: 'Region not found: Nowhere' }],
  ['sde_sql', { sql: 'DELETE FROM sde_types' }, null, { ok: false, error: 'Only SELECT queries are allowed' }],
  ['character_sql', { sql: 'SELECT * FROM users' }, null, { ok: false }],
  ['plan_route', { origin: 'Jita', destination: 'Nowhere', set_autopilot: null, prefer: null }, null, { ok: false, error: 'Unknown destination system: Nowhere' }],
  ['route_monitor', { action: 'stop' }, null, { ok: true, stopped: true }],
  ['heartbeat_config', { action: 'set_interval', interval_seconds: 5, check: null }, null, { ok: false }],
  ['intel_note', { action: 'delete', text: null, system: null, region: null, entity_name: null, tag: null, query: null, note_id: 999 }, null, { ok: false }],
  ['set_active_fit', { fitting: 'x' }, 'no-profile', { ok: false, error: 'USER.md not found. Refresh profile first.' }],
  ['batch_market_prices', { region_id: FORGE, type_ids: [TRITANIUM] }, 'esi.evetech.net', { ok: true, prices: [{ type_id: TRITANIUM, error: 'Market data unavailable' }] }],
  ['market_wide_summary', { type_id: TRITANIUM }, 'esi.evetech.net', { ok: false, status: 503 }],
  ['assets_summary', { top: null }, 'esi.evetech.net', { ok: false, status: 503 }],
  ['character_orders_summary', { top: null }, 'esi.evetech.net', { ok: false, status: 503 }],
  ['market_history_summary', { region_id: FORGE, type_id: TRITANIUM, days: 90 }, 'esi.evetech.net', { ok: false, status: 503 }],
  ['system_metric_snapshot', { metric: 'jumps', system_ids: [JITA] }, 'esi.evetech.net', { ok: false, status: 503 }],
  ['dynamic_item_summary', { type_id: 47408, item_id: 1040000001, attribute_ids: [72] }, 'esi.evetech.net', { ok: false, status: 503 }],
  ['appraise_items', { items_text: '   ', region_id: null }, null, { ok: false, error: 'items_text is empty' }],
  ['osint_infer_home', { scope: 'character', id: 90000002, window_days: null, include_member_analysis: false, include_graph: false, include_llm_pattern_analysis: false }, 'api.eve-kill.com', { ok: true, hypotheses: [] }],
  ['analyze_local', { pilots: 'Prey Pilot', days: null }, 'esi.evetech.net', { ok: false }],
  ['analyze_scan', { paste: '', scan_type: null, days: null }, null, { ok: false, error: 'Empty paste.' }],
  ['map_bubble_intel', { system_id: 1, radius: null, ship_type_id: null }, null, { ok: false }],
  ['route_risk', { origin_system_id: JITA, destination_system_id: 1, mode: 'shortest', risk_weight: 0, draw_on_map: false }, null, { ok: false }],
  ['compare_ships', { ship_type_id_a: 0, ship_type_id_b: RIFTER }, null, { ok: false }],
  ['threat_explain', { system_id: 1 }, null, { ok: false }],
  ['industry_cost', { product_id: RIFTER, runs: 2, me_level: 10, te_level: 20 }, 'api.everef.net', { ok: false }],
  ['pilot_intel', { scope: 'corporation', id: 98000001 }, 'zkillboard.com', { ok: false }],
  ['abyssal_market', { type_id: 47409 }, 'mutamarket.com', { ok: false }],
  ['kill_activity_summary', { scope: 'system', id: JITA, activity: 'all', from: since(24), to: recent, evidence_limit: null }, 'api.eve-kill.com', { ok: false, status: 503 }],
  ['kill_search', { from: since(6), to: recent, system_ids: [JITA], constellation_ids: null, region_ids: null, character_ids: null, corporation_ids: null, alliance_ids: null, limit: 10 }, 'api.eve-kill.com', { ok: false, status: 503 }],
  // Cross-field rules the strict schema cannot express used to throw and abort the whole turn.
  ['kill_activity', { scope: 'system', id: JITA, activity: 'kills', from: null, to: null, limit: 10 }, null, { ok: false, blocked: true }],
  ['kill_detail', { action: 'detail', killmail_id: 0 }, null, { ok: false, blocked: true }],
  ['kill_intel', { action: 'character_stats', character_id: null, period: null, days: null, data_type: null, limit: null }, null, { ok: false, blocked: true }],
  ['kill_intel', { action: 'leaderboard', character_id: null, period: null, days: null, data_type: null, limit: null }, null, { ok: false, blocked: true }],
  ['kill_battles', { action: 'detail', battle_id: null, page: null, limit: null, sort: null }, null, { ok: false, blocked: true }],
  ['kill_watch', { action: 'watch' }, null, { ok: false, blocked: true }],
  ['doctrine_summary', { entity_id: 99000001, entity_type: 'alliance', from: since(7 * 24), to: recent, top: 3 }, 'mcp.eve-kill.com', { ok: false }],
  ['doctrine_detect', { entity: 99000001, type: 'alliance', since: 'bad', until: null, min_cluster_size: null, include_rookie_ships: null, limit: 5 }, null, { ok: false }],
  ['meta_pulse', { region_id: null, ship_category: null, since: null, until: null, min_cluster_size: null, include_rookie_ships: null, limit: null }, 'mcp.eve-kill.com', { ok: false, status: 503 }],
  ['killmail_forensics', { killmail_id: 130000001 }, 'mcp.eve-kill.com', { ok: false, status: 503 }],
  ['coalition_graph', { since: null, until: null, min_edge_weight: null, min_alliance_battles: null, focus_alliance: null, limit_edges: null }, 'mcp.eve-kill.com', { ok: false, status: 503 }],
  ['scout_route', { from: 'Jita', to: null, destinations: null, preference: null, mode: 'route' }, null, { ok: false }],
  ['compare_wormhole_types', { identifiers: ['C140', 'C140'] }, null, { ok: false, error: 'identifiers must be unique' }],
  ['scout_signatures', { system_name: null }, 'api.eve-scout.com', { ok: false, status: 503 }],
  ['scout_observations', {}, 'api.eve-scout.com', { ok: false, status: 503 }],
  ['scout_wormhole_types', { identifier: null, source: null, target: null }, 'api.eve-scout.com', { ok: false, status: 503 }],
  ['scout_systems', { query: 'Thera', space: null, limit: null }, 'api.eve-scout.com', { ok: false, status: 503 }],
  ['get_status', { fields: ['nope'] }, null, { ok: false, status: 400 }],
  ['get_universe_system_kills', { fields: null }, null, { ok: false, status: 400 }],
  ['post_universe_names', { ids: JSON.stringify([JITA]) }, 'esi.evetech.net', { ok: false, status: 503 }],
  ['local_parallel_batch', { calls: [{ id: 'bad', tool: 'count_universe_objects', arguments_json: '{"target_kind":1}' }] }, null, { ok: false, blocked: true }],
  ['delegate_read_subagents', { tasks: [] }, null, { ok: false, blocked: true }],
];

describe('agent tool functional smoke', () => {
  it.each(SUCCESS_CASES)('%s succeeds with realistic arguments', async (name, args, check) => {
    const result = await call(name, args);
    check(result);
  });

  it.each(FAILURE_CASES)('%s returns a structured failure (%#)', async (name, args, failHost, expected) => {
    if (failHost === 'no-profile') rmSync(PROFILE_DIR, { recursive: true, force: true });
    else if (failHost) failHosts.add(failHost);
    const result = await call(name, args);
    expect(result && typeof result).toBe('object');
    expect(result).toMatchObject(expected);
    expect(result.internal_error).toBeUndefined();
    if (result.ok === false) expect(typeof result.error === 'string' && result.error.length > 0, JSON.stringify(result)).toBe(true);
  });

  it('never makes a model call for OSINT unless the pattern pass is explicitly requested', async () => {
    const result = await call('osint_infer_home', {
      scope: 'character', id: 90000002, window_days: 30,
      include_member_analysis: null, include_graph: null, include_llm_pattern_analysis: null,
    });
    expect(result.ok).toBe(true);
    const providerCalls = vi.mocked(fetch).mock.calls
      .map(([input]) => String(input instanceof Request ? input.url : input))
      .filter((url) => url.includes('api.openai.com') || url.includes('modelhub'));
    expect(providerCalls).toEqual([]);
  });

  it('explains why web_search found nothing when every provider fails', async () => {
    failHosts.add('api.tavily.com');
    failHosts.add('wiki.eveuniversity.org');
    const result = await call('web_search', { query: 'black hole effect' });
    expect(result).toMatchObject({ ok: false, results: [] });
    expect(String(result.error)).toContain('HTTP 503');
  });
});
