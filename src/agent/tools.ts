import type { Db } from '../db/sqlite.js';
import { loadEsiCatalog, listEsiNamespaces } from '../eve/esi-catalog.js';
import type { NativeFunctionTool, NativeNamespaceTool, NativeTool } from './native-responses.js';

const SDE_SQL_TOOL_NAME = 'sde_sql';

export const SDE_SCHEMA = `Tables (all read-only, SQLite):
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
sde_raw_records (dataset_name TEXT, record_id TEXT, name TEXT, data_json TEXT) — raw SDE datasets like mapPlanets

data_json fields accessed via json_extract():
  sde_systems.data_json: security (float), securityClass (text)
  sde_types.data_json: mass, volume, capacity, basePrice, published (bool), marketGroupID, metaGroupID, portionSize
  sde_blueprints.data_json: activities.manufacturing.materials[], activities.manufacturing.products[]
  sde_raw_records.data_json for dataset_name='mapPlanets': solarSystemID, planetIndex, moonIDs[]`;

const UNIVERSE_COUNT_TOOL_NAME = 'count_universe_objects';
type UniverseTargetKind = 'system' | 'constellation' | 'region';
type UniverseObjectKind = 'constellations' | 'systems' | 'planets' | 'moons' | 'asteroid_belts' | 'stations' | 'stargates';

const ALWAYS_ON_FUNCTION_TOOLS: NativeFunctionTool[] = [
  {
    type: 'function',
    name: 'web_search',
    description: 'Search the web and EVE University Wiki for game mechanics, ships, modules, fits, tactics, wormholes, exploration, PvP, and any EVE or general topic. IMPORTANT: always query in English (e.g. "wormhole" not "вармхол", "black hole effect" not "чёрные дыры"). Returns articles with URLs — always include source URLs in your final response.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query in English for best results' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_plan',
    description: 'Create or replace the current request plan for the active task. Use when the work benefits from explicit step tracking or you need to record progress.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered plan steps to store for the current request.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable step identifier.' },
              title: { type: 'string', description: 'Short step title.' },
              status: { type: 'string', enum: ['pending', 'running', 'done', 'blocked', 'failed'] },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'IDs of prerequisite steps.',
              },
              notes: { type: 'string', description: 'Optional detail for the step.' },
            },
            required: ['id', 'title', 'status', 'depends_on', 'notes'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_eve_capabilities',
    description: 'Inspect the currently available ESI namespaces, granted scopes, and accessible operations for the active Telegram user/chat. Use this before private ESI access when the current capability set is not already known.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Short description of what you are trying to do with ESI.' },
      },
      required: ['intent'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'plan_route',
    description: 'Plan a route between two EVE systems. Returns up to 3 variants (secure/shortest/insecure) with jump count, security, recent kill stats, and hotspots. When requested, sets exact autopilot waypoints for the preferred route. Accepts system names or IDs.',
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
    name: UNIVERSE_COUNT_TOOL_NAME,
    description: 'Count static EVE geography objects from the local SDE for a named system, constellation, or region. Supports constellations, systems, planets, moons, asteroid belts, stations, and stargates. Use for simple aggregate questions like "сколько систем в регионе" or "сколько планет в созвездии". Static data only: do not use web_search or live ESI when this tool is sufficient.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        target_kind: { type: 'string', enum: ['system', 'constellation', 'region'] },
        target_name: { type: 'string', description: 'Exact or case-insensitive EVE system, constellation, or region name.' },
        object_kind: { type: 'string', enum: ['constellations', 'systems', 'planets', 'moons', 'asteroid_belts', 'stations', 'stargates'] },
      },
      required: ['target_kind', 'target_name', 'object_kind'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: SDE_SQL_TOOL_NAME,
    description: 'Run a read-only SQL query against the local EVE SDE SQLite. See <sde_schema> in the developer prompt for available tables and fields. Batch multiple lookups using WHERE IN (...).',
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

const ZKILL_RESPONSE_FIELDS = [
  'killmail_id',
  'time',
  'system',
  'system_sec',
  'victim_name',
  'victim_corp',
  'victim_ship',
  'attacker_name',
  'attacker_corp',
  'attacker_ship',
  'attacker_weapon',
  'attackers_count',
  'value_m',
  'solo',
  'npc',
  'url',
] as const;

const DEFERRED_ZKILL_TOOLS: NativeFunctionTool[] = [
  {
    type: 'function',
    name: ZKILL_TOOL_NAME,
    description: `Query zKillboard public kill feed. Top results are enriched with ESI killmail detail (victim, attacker, ship, value, time). Use for PvP activity, kill history, fit research. Response fields: ${ZKILL_RESPONSE_FIELDS.join(', ')}. Use fields to request only the subset you need.\n\n${ZKILL_API_REF}`,
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'zKill API path segments (e.g. "kills/systemID/30002768/pastSeconds/3600/")' },
        detail_limit: { type: 'integer', description: 'How many killmails to enrich with ESI details (0-10, default 3)' },
        fields: {
          type: ['array', 'null'],
          items: { type: 'string', enum: [...ZKILL_RESPONSE_FIELDS] },
          description: `Optional response fields to return per killmail. Allowed: ${ZKILL_RESPONSE_FIELDS.join(', ')}. Null returns all fields.`,
        },
      },
      required: ['path', 'detail_limit', 'fields'],
      additionalProperties: false,
    },
  },
];

const BATCH_MARKET_TOOL_NAME = 'batch_market_prices';

const BATCH_MARKET_TOOL: NativeFunctionTool = {
  type: 'function',
  name: BATCH_MARKET_TOOL_NAME,
  description: 'Get best prices for MULTIPLE items at once. Returns min sell price, max buy price, and available volume per item. Use for fits, shopping lists, cost estimation — any time you need prices for 2+ items. Much more efficient than calling get_markets_region_id_orders per item.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      region_id: { type: 'integer', description: '10000002=The Forge (Jita), 10000043=Domain (Amarr), 10000032=Sinq Laison (Dodixie)' },
      type_ids: { type: 'array', items: { type: 'integer' }, description: 'Array of type_ids to look up. Resolve via sde_sql first.' },
    },
    required: ['region_id', 'type_ids'],
    additionalProperties: false,
  },
};

export async function buildNativeAgentTools(mode: 'full' | 'static_aggregate' = 'full'): Promise<NativeTool[]> {
  if (mode === 'static_aggregate') {
    return ALWAYS_ON_FUNCTION_TOOLS.filter((tool) =>
      tool.name === UNIVERSE_COUNT_TOOL_NAME
      || tool.name === SDE_SQL_TOOL_NAME,
    );
  }

  return [
    { type: 'tool_search' },
    ...ALWAYS_ON_FUNCTION_TOOLS,
    BATCH_MARKET_TOOL,
    buildZkillNamespace(),
    ...(await listEsiNamespaces()),
  ];
}

export function getAlwaysOnFunctionToolNames(): string[] {
  return ALWAYS_ON_FUNCTION_TOOLS.map((tool) => tool.name);
}

export function isBatchMarketTool(name: string): boolean {
  return name === BATCH_MARKET_TOOL_NAME;
}

export function isUniverseCountTool(name: string): boolean {
  return name === UNIVERSE_COUNT_TOOL_NAME;
}

export function isSdeSqlTool(name: string): boolean {
  return name === SDE_SQL_TOOL_NAME;
}

export function isZkillToolName(name: string): boolean {
  return name === ZKILL_TOOL_NAME;
}

export function isDeferredLookupToolName(name: string): boolean {
  return isZkillToolName(name) || isBatchMarketTool(name);
}

const MAX_SDE_ROWS = 50;
const SDE_OBJECT_CACHE = new WeakMap<Db, Set<string>>();
const SDE_WRITE_KEYWORDS = new Set(['ALTER', 'ATTACH', 'CREATE', 'DELETE', 'DETACH', 'DROP', 'INSERT', 'PRAGMA', 'REINDEX', 'REPLACE', 'UPDATE', 'VACUUM']);
const SDE_ALIAS_STOP_KEYWORDS = new Set([
  'CROSS',
  'EXCEPT',
  'FULL',
  'GROUP',
  'HAVING',
  'INDEXED',
  'INNER',
  'INTERSECT',
  'JOIN',
  'LEFT',
  'LIMIT',
  'NATURAL',
  'ON',
  'ORDER',
  'RIGHT',
  'UNION',
  'USING',
  'WHERE',
  'WINDOW',
]);
const SDE_CTE_HINT_KEYWORDS = new Set(['MATERIALIZED', 'NOT']);
const SDE_IGNORED_PLAN_REFERENCES = new Set(['constant']);

type SqlToken = {
  value: string;
  upper: string;
};

type QueryPlanRow = {
  detail: string;
};

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    if (char === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(index + 2, sql.length);
      continue;
    }

    if (char === '\'') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '\'' && sql[index + 1] === '\'') {
          index += 2;
          continue;
        }
        if (sql[index] === '\'') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      let value = '';
      index += 1;
      while (index < sql.length) {
        const current = sql[index];
        if (current === closing) {
          if (closing !== ']' && sql[index + 1] === closing) {
            value += closing;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ value, upper: value.toUpperCase() });
      continue;
    }

    if (/[A-Za-z_]/u.test(char)) {
      let value = char;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index])) {
        value += sql[index];
        index += 1;
      }
      tokens.push({ value, upper: value.toUpperCase() });
      continue;
    }

    if (/[0-9]/u.test(char)) {
      let value = char;
      index += 1;
      while (index < sql.length && /[0-9.]/u.test(sql[index])) {
        value += sql[index];
        index += 1;
      }
      tokens.push({ value, upper: value.toUpperCase() });
      continue;
    }

    tokens.push({ value: char, upper: char.toUpperCase() });
    index += 1;
  }

  return tokens;
}

function isSqlIdentifierToken(token: SqlToken | undefined): token is SqlToken {
  return token !== undefined && /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(token.value);
}

function normalizeSqlIdentifier(value: string): string {
  return value.toLowerCase();
}

function normalizeObjectReference(value: string): string | null {
  const parts = value
    .split('.')
    .map((part) => normalizeSqlIdentifier(part))
    .filter((part) => part.length > 0);

  if (parts.length === 0 || parts.length > 2) {
    return null;
  }

  return parts.join('.');
}

function skipParenthesizedTokens(tokens: SqlToken[], startIndex: number): number {
  let depth = 0;
  let index = startIndex;

  while (index < tokens.length) {
    if (tokens[index].value === '(') {
      depth += 1;
    } else if (tokens[index].value === ')') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }

  return index;
}

function extractCteNames(tokens: SqlToken[]): Set<string> {
  const cteNames = new Set<string>();
  let index = 0;

  if (tokens[index]?.upper !== 'WITH') {
    return cteNames;
  }

  index += 1;
  if (tokens[index]?.upper === 'RECURSIVE') {
    index += 1;
  }

  while (index < tokens.length) {
    const nameToken = tokens[index];
    if (!isSqlIdentifierToken(nameToken)) {
      return cteNames;
    }

    cteNames.add(normalizeSqlIdentifier(nameToken.value));
    index += 1;

    if (tokens[index]?.value === '(') {
      index = skipParenthesizedTokens(tokens, index);
    }

    if (tokens[index]?.upper !== 'AS') {
      return cteNames;
    }
    index += 1;

    while (SDE_CTE_HINT_KEYWORDS.has(tokens[index]?.upper ?? '')) {
      index += 1;
    }

    if (tokens[index]?.value !== '(') {
      return cteNames;
    }
    index = skipParenthesizedTokens(tokens, index);

    if (tokens[index]?.value === ',') {
      index += 1;
      continue;
    }

    return cteNames;
  }

  return cteNames;
}

function extractTableAliases(tokens: SqlToken[]): Map<string, string> {
  const aliases = new Map<string, string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.upper !== 'FROM' && token.upper !== 'JOIN') {
      continue;
    }

    let cursor = index + 1;
    if (tokens[cursor]?.value === '(') {
      continue;
    }

    const nameParts: string[] = [];
    while (isSqlIdentifierToken(tokens[cursor])) {
      nameParts.push(tokens[cursor].value);
      if (tokens[cursor + 1]?.value !== '.') {
        cursor += 1;
        break;
      }
      cursor += 2;
    }

    if (nameParts.length === 0) {
      continue;
    }

    const normalizedObject = normalizeObjectReference(nameParts.join('.'));
    if (normalizedObject === null) {
      continue;
    }

    aliases.set(normalizedObject, normalizedObject);

    if (tokens[cursor]?.upper === 'AS') {
      cursor += 1;
    }

    if (isSqlIdentifierToken(tokens[cursor]) && !SDE_ALIAS_STOP_KEYWORDS.has(tokens[cursor].upper)) {
      aliases.set(normalizeSqlIdentifier(tokens[cursor].value), normalizedObject);
    }
  }

  return aliases;
}

function extractPlanReferences(detail: string): string[] {
  const references = new Set<string>();
  const patterns = [
    /\b(?:SCAN|SEARCH)\s+(?:TABLE\s+)?([^\s]+)/giu,
    /\bON TABLE\s+([^\s]+)/giu,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(detail)) !== null) {
      references.add(match[1]);
    }
  }

  return [...references];
}

function getAllowedSdeObjects(db: Db): Set<string> {
  const cached = SDE_OBJECT_CACHE.get(db);
  if (cached !== undefined) {
    return cached;
  }

  const rows = db
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name GLOB 'sde_*'
    `)
    .all() as { name: string }[];

  const allowed = new Set(rows.map((row) => row.name.toLowerCase()));
  SDE_OBJECT_CACHE.set(db, allowed);
  return allowed;
}

function validateSdeReference(reference: string, allowedObjects: Set<string>): { ok: true; objectName: string } | { ok: false; error: string } {
  const normalized = normalizeObjectReference(reference);
  if (normalized === null) {
    return { ok: false, error: `Unsupported query source "${reference}"` };
  }

  const parts = normalized.split('.');
  const schemaName = parts.length === 2 ? parts[0] : null;
  const objectName = parts[parts.length - 1];

  if (schemaName !== null && schemaName !== 'main') {
    return { ok: false, error: `Only main SDE tables are allowed (got "${reference}")` };
  }

  if (!allowedObjects.has(objectName)) {
    return { ok: false, error: `Only SDE tables are allowed (got "${reference}")` };
  }

  return { ok: true, objectName };
}

function validateSdeSqlSources(db: Db, sql: string): string | null {
  const tokens = tokenizeSql(sql);
  const firstToken = tokens[0]?.upper;

  if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
    return 'Only SELECT queries are allowed';
  }

  for (const token of tokens) {
    if (SDE_WRITE_KEYWORDS.has(token.upper)) {
      return 'Write operations are not allowed';
    }
  }

  const allowedObjects = getAllowedSdeObjects(db);
  const aliasMap = extractTableAliases(tokens);
  const cteNames = extractCteNames(tokens);

  let planRows: QueryPlanRow[];
  try {
    planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as QueryPlanRow[];
  } catch (err) {
    return `SQL error: ${(err as Error).message}`;
  }

  const referencedObjects = new Set<string>();

  for (const row of planRows) {
    for (const rawReference of extractPlanReferences(row.detail)) {
      const normalizedReference = normalizeObjectReference(rawReference);
      const resolvedReference = aliasMap.get(normalizedReference ?? '') ?? normalizedReference;

      if (resolvedReference === null) {
        return `Query references an unsupported source: ${rawReference}`;
      }

      const baseName = resolvedReference.split('.').at(-1);
      if (baseName !== undefined && (cteNames.has(baseName) || SDE_IGNORED_PLAN_REFERENCES.has(baseName))) {
        continue;
      }

      const validation = validateSdeReference(resolvedReference, allowedObjects);
      if (!validation.ok) {
        return validation.error;
      }

      referencedObjects.add(validation.objectName);
    }
  }

  if (referencedObjects.size === 0) {
    return 'Query must read from at least one SDE table';
  }

  return null;
}

type UniverseTargetContext = {
  target_kind: UniverseTargetKind;
  target_name: string;
  system_id?: number;
  constellation_id?: number;
  region_id?: number;
  constellation_name?: string | null;
  region_name?: string | null;
};

export type UniverseCountResult =
  | ({
      ok: true;
      object_kind: UniverseObjectKind;
      count: number;
      /** Extra: planet count when object_kind='moons'. */
      planet_count?: number;
      /** Extra: system count when object_kind='moons' and target_kind='region'. */
      system_count?: number;
    } & UniverseTargetContext)
  | {
      ok: false;
      error: string;
    };

function resolveUniverseTargetContext(
  db: Db,
  targetKind: UniverseTargetKind,
  targetName: string,
): UniverseTargetContext | null {
  if (targetKind === 'system') {
    const row = db.prepare(`
      SELECT
        s.system_id AS system_id,
        s.name AS system_name,
        c.constellation_id AS constellation_id,
        c.name AS constellation_name,
        r.region_id AS region_id,
        r.name AS region_name
      FROM sde_systems s
      LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
      LEFT JOIN sde_regions r ON r.region_id = c.region_id
      WHERE s.name = ? COLLATE NOCASE
      LIMIT 1
    `).get(targetName) as {
      system_id: number;
      system_name: string;
      constellation_id: number | null;
      constellation_name: string | null;
      region_id: number | null;
      region_name: string | null;
    } | undefined;

    if (!row) return null;
    return {
      target_kind: 'system',
      target_name: row.system_name,
      system_id: row.system_id,
      constellation_id: row.constellation_id ?? undefined,
      constellation_name: row.constellation_name,
      region_id: row.region_id ?? undefined,
      region_name: row.region_name,
    };
  }

  if (targetKind === 'constellation') {
    const row = db.prepare(`
      SELECT
        c.constellation_id AS constellation_id,
        c.name AS constellation_name,
        r.region_id AS region_id,
        r.name AS region_name
      FROM sde_constellations c
      LEFT JOIN sde_regions r ON r.region_id = c.region_id
      WHERE c.name = ? COLLATE NOCASE
      LIMIT 1
    `).get(targetName) as {
      constellation_id: number;
      constellation_name: string;
      region_id: number | null;
      region_name: string | null;
    } | undefined;

    if (!row) return null;
    return {
      target_kind: 'constellation',
      target_name: row.constellation_name,
      constellation_id: row.constellation_id,
      region_id: row.region_id ?? undefined,
      region_name: row.region_name,
    };
  }

  const row = db.prepare(`
    SELECT region_id, name AS region_name
    FROM sde_regions
    WHERE name = ? COLLATE NOCASE
    LIMIT 1
  `).get(targetName) as { region_id: number; region_name: string } | undefined;

  if (!row) return null;
  return {
    target_kind: 'region',
    target_name: row.region_name,
    region_id: row.region_id,
  };
}

function isUniverseCountCombinationAllowed(targetKind: UniverseTargetKind, objectKind: UniverseObjectKind): boolean {
  if (targetKind === 'system') {
    return objectKind === 'planets'
      || objectKind === 'moons'
      || objectKind === 'asteroid_belts'
      || objectKind === 'stations'
      || objectKind === 'stargates';
  }
  if (targetKind === 'constellation') {
    return objectKind !== 'constellations';
  }
  return true;
}

function buildUniverseCountError(targetKind: UniverseTargetKind, objectKind: UniverseObjectKind): string {
  return `Cannot count ${objectKind} inside ${targetKind}.`;
}

export function executeUniverseObjectCount(db: Db, args: Record<string, unknown>): UniverseCountResult {
  const targetKind = args.target_kind === 'system' || args.target_kind === 'constellation' || args.target_kind === 'region'
    ? args.target_kind
    : null;
  const objectKind = args.object_kind === 'constellations'
    || args.object_kind === 'systems'
    || args.object_kind === 'planets'
    || args.object_kind === 'moons'
    || args.object_kind === 'asteroid_belts'
    || args.object_kind === 'stations'
    || args.object_kind === 'stargates'
    ? args.object_kind
    : null;
  const targetName = typeof args.target_name === 'string' ? args.target_name.trim() : '';

  if (!targetKind) {
    return { ok: false, error: 'target_kind must be one of: system, constellation, region.' };
  }
  if (!objectKind) {
    return { ok: false, error: 'object_kind must be one of: constellations, systems, planets, moons, asteroid_belts, stations, stargates.' };
  }
  if (!targetName) {
    return { ok: false, error: 'target_name must be a non-empty EVE geography name.' };
  }
  if (!isUniverseCountCombinationAllowed(targetKind, objectKind)) {
    return { ok: false, error: buildUniverseCountError(targetKind, objectKind) };
  }

  const target = resolveUniverseTargetContext(db, targetKind, targetName);
  if (!target) {
    return { ok: false, error: `${targetKind[0].toUpperCase()}${targetKind.slice(1)} not found: ${targetName}` };
  }

  let count = 0;

  switch (objectKind) {
    case 'constellations': {
      const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM sde_constellations
        WHERE region_id = ?
      `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'systems': {
      const row = targetKind === 'region'
        ? db.prepare(`
            SELECT COUNT(*) AS count
            FROM sde_systems s
            JOIN sde_constellations c ON c.constellation_id = s.constellation_id
            WHERE c.region_id = ?
          `).get(target.region_id) as { count: number }
        : db.prepare(`
            SELECT COUNT(*) AS count
            FROM sde_systems
            WHERE constellation_id = ?
          `).get(target.constellation_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'planets': {
      const row = targetKind === 'system'
        ? db.prepare(`
            SELECT COUNT(*) AS count
            FROM sde_raw_records
            WHERE dataset_name = 'mapPlanets'
              AND json_extract(data_json, '$.solarSystemID') = ?
          `).get(target.system_id) as { count: number }
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              WHERE p.dataset_name = 'mapPlanets'
                AND s.constellation_id = ?
            `).get(target.constellation_id) as { count: number }
          : db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE p.dataset_name = 'mapPlanets'
                AND c.region_id = ?
            `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'moons': {
      type MoonEnrichedRow = { moon_count: number; planet_count: number; system_count?: number };
      const enrichedRow: MoonEnrichedRow = targetKind === 'system'
        ? db.prepare(`
            SELECT
              COALESCE(SUM(
                CASE
                  WHEN json_type(data_json, '$.moonIDs') = 'array' THEN json_array_length(data_json, '$.moonIDs')
                  ELSE 0
                END
              ), 0) AS moon_count,
              COUNT(record_id) AS planet_count
            FROM sde_raw_records
            WHERE dataset_name = 'mapPlanets'
              AND json_extract(data_json, '$.solarSystemID') = ?
          `).get(target.system_id) as MoonEnrichedRow
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT
                COALESCE(SUM(
                  CASE
                    WHEN json_type(p.data_json, '$.moonIDs') = 'array' THEN json_array_length(p.data_json, '$.moonIDs')
                    ELSE 0
                  END
                ), 0) AS moon_count,
                COUNT(p.record_id) AS planet_count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              WHERE p.dataset_name = 'mapPlanets'
                AND s.constellation_id = ?
            `).get(target.constellation_id) as MoonEnrichedRow
          : db.prepare(`
              SELECT
                COALESCE(SUM(
                  CASE
                    WHEN json_type(p.data_json, '$.moonIDs') = 'array' THEN json_array_length(p.data_json, '$.moonIDs')
                    ELSE 0
                  END
                ), 0) AS moon_count,
                COUNT(p.record_id) AS planet_count,
                COUNT(DISTINCT s.system_id) AS system_count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE p.dataset_name = 'mapPlanets'
                AND c.region_id = ?
            `).get(target.region_id) as MoonEnrichedRow;
      count = Number(enrichedRow.moon_count ?? 0);
      return {
        ok: true as const,
        object_kind: objectKind,
        count,
        planet_count: Number(enrichedRow.planet_count ?? 0),
        ...(targetKind === 'region' && enrichedRow.system_count != null
          ? { system_count: Number(enrichedRow.system_count) }
          : {}),
        ...target,
      };
    }
    case 'asteroid_belts': {
      const row = targetKind === 'system'
        ? db.prepare(`
            SELECT COALESCE(SUM(
              CASE
                WHEN json_type(data_json, '$.asteroidBeltIDs') = 'array' THEN json_array_length(data_json, '$.asteroidBeltIDs')
                ELSE 0
              END
            ), 0) AS count
            FROM sde_raw_records
            WHERE dataset_name = 'mapPlanets'
              AND json_extract(data_json, '$.solarSystemID') = ?
          `).get(target.system_id) as { count: number }
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT COALESCE(SUM(
                CASE
                  WHEN json_type(p.data_json, '$.asteroidBeltIDs') = 'array' THEN json_array_length(p.data_json, '$.asteroidBeltIDs')
                  ELSE 0
                END
              ), 0) AS count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              WHERE p.dataset_name = 'mapPlanets'
                AND s.constellation_id = ?
            `).get(target.constellation_id) as { count: number }
          : db.prepare(`
              SELECT COALESCE(SUM(
                CASE
                  WHEN json_type(p.data_json, '$.asteroidBeltIDs') = 'array' THEN json_array_length(p.data_json, '$.asteroidBeltIDs')
                  ELSE 0
                END
              ), 0) AS count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE p.dataset_name = 'mapPlanets'
                AND c.region_id = ?
            `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'stations': {
      const row = targetKind === 'system'
        ? db.prepare('SELECT COUNT(*) AS count FROM sde_stations WHERE system_id = ?').get(target.system_id) as { count: number }
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_stations st
              JOIN sde_systems s ON s.system_id = st.system_id
              WHERE s.constellation_id = ?
            `).get(target.constellation_id) as { count: number }
          : db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_stations st
              JOIN sde_systems s ON s.system_id = st.system_id
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE c.region_id = ?
            `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'stargates': {
      const row = targetKind === 'system'
        ? db.prepare('SELECT COUNT(*) AS count FROM sde_stargates WHERE system_id = ?').get(target.system_id) as { count: number }
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_stargates sg
              JOIN sde_systems s ON s.system_id = sg.system_id
              WHERE s.constellation_id = ?
            `).get(target.constellation_id) as { count: number }
          : db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_stargates sg
              JOIN sde_systems s ON s.system_id = sg.system_id
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE c.region_id = ?
            `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
  }

  return {
    ok: true,
    object_kind: objectKind,
    count,
    ...target,
  };
}

export function executeSdeSql(db: Db, sql: string): { ok: boolean; rows: unknown[]; count: number; error: string | null } {
  const trimmed = sql.trim();
  const validationError = validateSdeSqlSources(db, trimmed);
  if (validationError !== null) {
    return { ok: false, rows: [], count: 0, error: validationError };
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
  if (name === 'update_plan') {
    return 'write';
  }
  if (getAlwaysOnFunctionToolNames().includes(name) || isZkillToolName(name) || isBatchMarketTool(name)) {
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
