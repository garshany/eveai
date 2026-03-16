import type { Db } from '../db/sqlite.js';
import { loadEsiCatalog, listEsiNamespaces } from '../eve/esi-catalog.js';
import type { NativeFunctionTool, NativeNamespaceTool, NativeTool } from './native-responses.js';

const SDE_SQL_TOOL_NAME = 'sde_sql';

const SDE_SCHEMA = `Tables (all read-only, SQLite):
sde_types (type_id INT, name TEXT, group_id INT, data_json TEXT) — 51k items/ships/modules
sde_groups (group_id INT, name TEXT, category_id INT, data_json TEXT)
sde_categories (category_id INT, name TEXT, data_json TEXT)
sde_market_groups (market_group_id INT, name TEXT, parent_group_id INT, data_json TEXT)
sde_systems (system_id INT, name TEXT, constellation_id INT, data_json TEXT) — json has security
sde_constellations (constellation_id INT, name TEXT, region_id INT, data_json TEXT)
sde_regions (region_id INT, name TEXT, data_json TEXT)
sde_stations (station_id INT, name TEXT, system_id INT, data_json TEXT)
sde_stargates (stargate_id INT, system_id INT, destination_system_id INT, destination_stargate_id INT, data_json TEXT)
sde_blueprints (blueprint_type_id INT, name TEXT, data_json TEXT)
sde_factions (faction_id INT, name TEXT, data_json TEXT)
sde_npc_corporations (corporation_id INT, name TEXT, station_id INT, data_json TEXT)
sde_type_dogma (type_id INT, data_json TEXT)
sde_type_bonus (type_id INT, data_json TEXT)
sde_type_materials (type_id INT, name TEXT, data_json TEXT)

data_json fields accessed via json_extract():
  sde_systems.data_json: security (float), securityClass (text)
  sde_types.data_json: mass, volume, capacity, basePrice, published (bool), marketGroupID, metaGroupID, portionSize
  sde_blueprints.data_json: activities.manufacturing.materials[], activities.manufacturing.products[]`;

const ALWAYS_ON_FUNCTION_TOOLS: NativeFunctionTool[] = [
  {
    type: 'function',
    name: 'web_search',
    description: 'Searches backend-supported EVE and general web sources. Use only for external background info, never to choose ESI operations or SDE tools.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        source: { type: 'string', enum: ['eve_uni', 'esi_docs', 'general', 'openai', 'all'] },
        limit: { type: 'integer' },
      },
      required: ['query', 'source', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'plan_route',
    description: 'Plan a route between two EVE systems. Returns up to 3 variants (secure/shortest/insecure) with jump count, security, recent kill stats, and hotspots. Automatically sets autopilot. Accepts system names or IDs.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Origin system name or ID. Use "current" to use the current location from prompt context.' },
        destination: { type: 'string', description: 'Destination system name or ID' },
        set_autopilot: { type: ['boolean', 'null'], description: 'Set autopilot to the preferred route (default true)' },
        prefer: { type: ['string', 'null'], enum: ['secure', 'shortest', 'insecure', null], description: 'Which route to prefer for autopilot (default: secure)' },
      },
      required: ['origin', 'destination', 'set_autopilot', 'prefer'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: SDE_SQL_TOOL_NAME,
    description: `Run a read-only SQL query against the local EVE Static Data Export (SDE) SQLite database. Use for all static data: item/ship/module lookups, system/region info, route system names, blueprint materials, etc. Prefer this over ESI for any static data.\n\n${SDE_SCHEMA}`,
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
];

const ZKILL_TOOL_NAME = 'zkill';

const ZKILL_API_REF = `zKillboard API (https://zkillboard.com/api/).
Build path from segments, all ending with /.
Modifiers: kills/, losses/, solo/, w-space/, finalblow-only/, npc/0|1/, awox/0|1/
Filters: characterID/#/, corporationID/#/, allianceID/#/, systemID/#/, regionID/#/, shipTypeID/#/, groupID/#/, factionID/#/, warID/#/
Time: pastSeconds/#/ (max 604800, multiples of 3600), year/Y/ (needs month), month/m/, page/#/
Value: iskValue/#/ (min ISK threshold)
Examples: kills/systemID/30002768/pastSeconds/3600/, losses/characterID/268946627/, kills/shipTypeID/17715/solo/pastSeconds/86400/
Rules: need killID/ OR at least 2 modifiers. Max 1000 results. Use CCP IDs.`;

const DEFERRED_ZKILL_TOOLS: NativeFunctionTool[] = [
  {
    type: 'function',
    name: ZKILL_TOOL_NAME,
    description: `Query zKillboard public kill feed. Top results are enriched with ESI killmail detail (victim, attacker, ship, value, time). Use for PvP activity, kill history, fit research.\n\n${ZKILL_API_REF}`,
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'zKill API path segments (e.g. "kills/systemID/30002768/pastSeconds/3600/")' },
        detail_limit: { type: 'integer', description: 'How many killmails to enrich with ESI details (0-10, default 3)' },
      },
      required: ['path', 'detail_limit'],
      additionalProperties: false,
    },
  },
];

export async function buildNativeAgentTools(): Promise<NativeTool[]> {
  return [
    { type: 'tool_search' },
    ...ALWAYS_ON_FUNCTION_TOOLS,
    buildZkillNamespace(),
    ...(await listEsiNamespaces()),
  ];
}

export function getAlwaysOnFunctionToolNames(): string[] {
  return ALWAYS_ON_FUNCTION_TOOLS.map((tool) => tool.name);
}

export function isSdeSqlTool(name: string): boolean {
  return name === SDE_SQL_TOOL_NAME;
}

export function isZkillToolName(name: string): boolean {
  return name === ZKILL_TOOL_NAME;
}

export function isDeferredLookupToolName(name: string): boolean {
  return isZkillToolName(name);
}

const MAX_SDE_ROWS = 50;

export function executeSdeSql(db: Db, sql: string): { ok: boolean; rows: unknown[]; count: number; error: string | null } {
  const trimmed = sql.trim();

  // Only allow SELECT
  if (!/^SELECT\b/i.test(trimmed)) {
    return { ok: false, rows: [], count: 0, error: 'Only SELECT queries are allowed' };
  }

  // Block writes
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA)\b/i.test(trimmed)) {
    return { ok: false, rows: [], count: 0, error: 'Write operations are not allowed' };
  }

  try {
    const stmt = db.prepare(trimmed);
    const rows = stmt.all() as unknown[];
    const truncated = rows.length > MAX_SDE_ROWS;
    return {
      ok: true,
      rows: truncated ? rows.slice(0, MAX_SDE_ROWS) : rows,
      count: rows.length,
      error: truncated ? `Truncated to ${MAX_SDE_ROWS} rows (total: ${rows.length})` : null,
    };
  } catch (err) {
    return { ok: false, rows: [], count: 0, error: `SQL error: ${(err as Error).message}` };
  }
}

export { planRoute } from '../eve/route-planner.js';
export type { PlanRouteArgs } from '../eve/route-planner.js';

export async function getToolPolicy(name: string): Promise<'read' | 'write' | 'ui' | null> {
  if (getAlwaysOnFunctionToolNames().includes(name) || isZkillToolName(name)) {
    return 'read';
  }
  const catalog = await loadEsiCatalog();
  return catalog.get(name)?.toolPolicy ?? null;
}

function buildZkillNamespace(): NativeNamespaceTool {
  return {
    type: 'namespace',
    name: 'eve_zkill',
    description: 'Public zKillboard-derived activity, system kill, and fit-meta tools.',
    tools: DEFERRED_ZKILL_TOOLS,
  };
}
