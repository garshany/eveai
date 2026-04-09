import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';
import type { NativeFunctionTool, NativeNamespaceTool } from '../agent/native-responses.js';
import { fetchWithTimeout } from './http.js';

export type EsiOperationMeta = {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  namespace: string;
  description: string;
  requiresAuth: boolean;
  requiredScopes: string[];
  paginationType: 'none' | 'x-pages';
  hiddenPageParam: boolean;
  toolPolicy: 'read' | 'write' | 'ui';
  responseFields: string[] | null;
  parameters: EsiParameterMeta[];
  bodyParameter: EsiBodyParameterMeta | null;
  tool: NativeFunctionTool;
};

export type EsiNamespaceMeta = {
  name: string;
  description: string;
  tools: NativeFunctionTool[];
};

export type EsiParameterMeta = {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: Record<string, unknown>;
  collectionFormat: string | null;
};

export type EsiBodyParameterMeta = {
  name: string;
  required: boolean;
};

type SwaggerSpec = {
  basePath?: string;
  paths?: Record<string, Record<string, SwaggerOperation>>;
  parameters?: Record<string, SwaggerParameter>;
  securityDefinitions?: Record<string, unknown>;
};

type SwaggerOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<SwaggerParameter | { $ref: string }>;
  security?: Array<Record<string, string[]>>;
  responses?: Record<string, SwaggerResponse>;
};

type SwaggerParameter = {
  name?: string;
  in?: 'path' | 'query' | 'header' | 'body';
  required?: boolean;
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: SwaggerParameter;
  collectionFormat?: string;
  schema?: Record<string, unknown>;
};

type SwaggerResponse = {
  schema?: SwaggerSchema;
};

type SwaggerSchema = {
  type?: string;
  items?: SwaggerSchema;
  properties?: Record<string, SwaggerSchema>;
};

// Operations excluded from agent tools — static equivalents live in SDE.
// Includes both list endpoints and by-ID endpoints when SDE has the same data.
const EXCLUDED_OPERATIONS = new Set([
  // List endpoints (return arrays of IDs)
  'get_universe_systems',        // ~8500 IDs → sde_systems
  'get_universe_types',          // ~51000 IDs → sde_types
  'get_universe_categories',     // → sde_categories
  'get_universe_groups',         // → sde_groups
  'get_universe_constellations', // → sde_constellations
  'get_universe_regions',        // → sde_regions
  'get_universe_ancestries',     // → SDE
  'get_universe_bloodlines',     // → SDE
  'get_universe_factions',       // → sde_factions
  'get_universe_graphics',       // → SDE
  'get_universe_races',          // → SDE
  // By-ID endpoints with full SDE coverage — model must use sde_sql instead
  'get_universe_systems_system_id',                // → sde_systems (name, security, constellation_id, stargates, stations)
  'get_universe_constellations_constellation_id',  // → sde_constellations (name, region_id, systems)
  'get_universe_regions_region_id',                // → sde_regions (name, constellations)
  'get_universe_stargates_stargate_id',            // → sde_stargates (destination_system_id, destination_stargate_id)
  'get_universe_stations_station_id',              // → sde_stations (name, system_id)
  'get_universe_types_type_id',                    // → sde_types (name, group_id, data_json with mass/volume/etc)
  'get_universe_groups_group_id',                  // → sde_groups (name, category_id)
  'get_universe_categories_category_id',           // → sde_categories (name)
  'get_universe_graphics_graphic_id',              // → SDE
]);

/**
 * Bulk operations that return massive arrays without server-side filtering.
 * The executor fetches all rows, then filters client-side by the given key.
 * Model must supply `filter_ids` (array of IDs) to select specific rows.
 */
export const BULK_FILTER_OPERATIONS: Record<string, { filterKey: string; description: string }> = {
  get_universe_system_kills:  { filterKey: 'system_id',       description: 'Filter by system_id (array of integers). Returns NPC/ship/pod kills per system in the last hour.' },
  get_universe_system_jumps:  { filterKey: 'system_id',       description: 'Filter by system_id (array of integers). Returns jump count per system in the last hour.' },
  get_markets_prices:         { filterKey: 'type_id',         description: 'Filter by type_id (array of integers). Returns adjusted_price and average_price per item.' },
  get_industry_systems:       { filterKey: 'solar_system_id', description: 'Filter by solar_system_id (array of integers). Returns manufacturing/research cost indices.' },
  get_sovereignty_map:        { filterKey: 'system_id',       description: 'Filter by system_id (array of integers). Returns sovereignty holder (alliance/corp/faction).' },
};

const HIDDEN_PARAMS = new Set([
  'datasource',
  'token',
  'user_agent',
  'if_none_match',
  'language',
  'accept_language',
  'page',
]);

let catalogPromise: Promise<Map<string, EsiOperationMeta>> | null = null;

export async function loadEsiCatalog(): Promise<Map<string, EsiOperationMeta>> {
  if (!catalogPromise) {
    catalogPromise = loadEsiCatalogInternal();
  }
  return catalogPromise;
}

export async function listEsiTools(): Promise<NativeFunctionTool[]> {
  const catalog = await loadEsiCatalog();
  return [...catalog.values()].map((entry) => entry.tool);
}

export async function listEsiNamespaces(): Promise<NativeNamespaceTool[]> {
  const catalog = await loadEsiCatalog();
  const namespaces = new Map<string, EsiNamespaceMeta>();
  for (const entry of catalog.values()) {
    const namespace = planHostedNamespace(entry);
    const bucket = namespaces.get(namespace.name) ?? {
      name: namespace.name,
      description: namespace.description,
      tools: [],
    };
    bucket.tools.push(entry.tool);
    namespaces.set(namespace.name, bucket);
  }

  return [...namespaces.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((namespace) => ({
      type: 'namespace',
      name: namespace.name,
      description: namespace.description,
      tools: namespace.tools
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
    }));
}

async function loadEsiCatalogInternal(): Promise<Map<string, EsiOperationMeta>> {
  const spec = await loadSwaggerSpec();
  const sharedParameters = spec.parameters ?? {};
  const catalog = new Map<string, EsiOperationMeta>();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [rawMethod, operation] of Object.entries(methods)) {
      const method = rawMethod.toUpperCase();
      if (!isHttpMethod(method) || !operation?.operationId) continue;
      if (EXCLUDED_OPERATIONS.has(operation.operationId)) continue;
      const parameters = (operation.parameters ?? [])
        .map((parameter) => resolveParameter(parameter, sharedParameters))
        .filter((parameter): parameter is SwaggerParameter => !!parameter);
      const hiddenPageParam = parameters.some((parameter) => parameter.name?.toLowerCase() === 'page');
      const exposedParams = parameters.filter((parameter) => !parameter.name || !HIDDEN_PARAMS.has(parameter.name.toLowerCase()));
      const bodyParameter = exposedParams.find((parameter) => parameter.in === 'body') ?? null;
      const requiredScopes = extractRequiredScopes(operation.security);
      const namespace = buildNamespace(path);
      const responseFields = extractResponseFieldNames(operation);
      const bulkSpec = BULK_FILTER_OPERATIONS[operation.operationId] ?? null;
      const toolParameters = buildToolParameters(exposedParams, bodyParameter, responseFields, bulkSpec);
      const description = buildDescription(method, path, operation, requiredScopes, responseFields, bulkSpec);
      const toolPolicy = namespace.includes('ui')
        ? 'ui'
        : method === 'GET'
          ? 'read'
          : 'write';
      const meta: EsiOperationMeta = {
        name: operation.operationId,
        method,
        path,
        namespace,
        description,
        requiresAuth: requiredScopes.length > 0,
        requiredScopes,
        paginationType: method === 'GET' && hiddenPageParam ? 'x-pages' : 'none',
        hiddenPageParam,
        toolPolicy,
        responseFields,
        parameters: exposedParams
          .filter((parameter) => parameter.in === 'path' || parameter.in === 'query' || parameter.in === 'header')
          .flatMap((parameter) => {
            const name = parameter.name;
            if (!name) return [];
            const schema = buildScalarSchema(parameter, parameter.required ?? false);
            return [{
              name,
              in: parameter.in as 'path' | 'query' | 'header',
              required: parameter.required ?? false,
              schema,
              collectionFormat: parameter.collectionFormat ?? null,
            }];
          }),
        bodyParameter: bodyParameter?.name
          ? { name: bodyParameter.name, required: bodyParameter.required ?? false }
          : null,
        tool: {
          type: 'function',
          name: operation.operationId,
          description,
          strict: true,
          defer_loading: true,
          parameters: toolParameters,
        },
      };
      catalog.set(meta.name, meta);
    }
  }
  return catalog;
}

async function loadSwaggerSpec(): Promise<SwaggerSpec> {
  const cachePath = config.esi?.catalogCachePath ?? './data/cache/esi-swagger.json';
  if (isTestEnvironment()) {
    try {
      return JSON.parse(await readFile(cachePath, 'utf-8')) as SwaggerSpec;
    } catch {
      throw new Error(`ESI swagger cache is missing: ${cachePath}`);
    }
  }

  try {
    const res = await fetchWithTimeout(config.esi?.specUrl ?? 'https://esi.evetech.net/latest/swagger.json', {
      headers: {
        Accept: 'application/json',
        'User-Agent': config.esi.userAgent,
        'X-Compatibility-Date': config.esi.compatibilityDate,
      },
    }, config.esi.requestTimeoutMs);
    if (res.ok) {
      const json = await res.json() as SwaggerSpec;
      await writeCache(cachePath, JSON.stringify(json));
      return json;
    }
  } catch {
    // fall back to local cache
  }

  try {
    return JSON.parse(await readFile(cachePath, 'utf-8')) as SwaggerSpec;
  } catch {
    throw new Error(`ESI swagger cache is missing: ${cachePath}`);
  }
}

function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

async function writeCache(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

function resolveParameter(
  parameter: SwaggerParameter | { $ref: string },
  sharedParameters: Record<string, SwaggerParameter>,
): SwaggerParameter | null {
  if ('$ref' in parameter) {
    const ref = parameter.$ref.trim();
    const name = ref.split('/').pop() ?? '';
    return sharedParameters[name] ?? null;
  }
  return parameter;
}

function buildToolParameters(
  parameters: SwaggerParameter[],
  bodyParameter: SwaggerParameter | null,
  responseFields: string[] | null,
  bulkSpec: { filterKey: string; description: string } | null = null,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of parameters) {
    if (!parameter.name || parameter.in === 'body') continue;
    properties[parameter.name] = buildScalarSchema(parameter, parameter.required ?? false);
    required.push(parameter.name);
  }
  if (bodyParameter?.name) {
    properties[bodyParameter.name] = {
      type: bodyParameter.required ? 'string' : ['string', 'null'],
      description: `${bodyParameter.description ?? 'Request body'} JSON string`,
    };
    required.push(bodyParameter.name);
  }
  if (bulkSpec) {
    properties.filter_ids = {
      type: 'array',
      items: { type: 'integer' },
      description: `REQUIRED. ${bulkSpec.description}`,
    };
    required.push('filter_ids');
  }
  properties.fields = {
    type: ['array', 'null'],
    items: responseFields && responseFields.length > 0
      ? { type: 'string', enum: responseFields }
      : { type: 'string' },
    description: buildFieldsParameterDescription(responseFields),
  };
  required.push('fields');

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function extractResponseFieldNames(operation: SwaggerOperation): string[] | null {
  const responseSchema = operation.responses?.['200']?.schema
    ?? operation.responses?.['201']?.schema
    ?? null;
  if (!responseSchema) return null;

  const objectSchema = responseSchema.type === 'array'
    ? responseSchema.items ?? null
    : responseSchema;
  if (!objectSchema?.properties) return null;

  const fields = Object.keys(objectSchema.properties);
  return fields.length > 0 ? fields.sort((left, right) => left.localeCompare(right)) : null;
}

function buildScalarSchema(parameter: SwaggerParameter, required: boolean): Record<string, unknown> {
  const baseType = normalizeParameterType(parameter.type ?? 'string');
  const schema: Record<string, unknown> = {
    type: baseType === 'array'
      ? 'array'
      : required
        ? baseType
        : [baseType, 'null'],
  };
  if (parameter.description) schema.description = parameter.description;
  if (Array.isArray(parameter.enum) && parameter.enum.length > 0) schema.enum = parameter.enum;
  if (baseType === 'array') {
    schema.items = buildArrayItems(parameter.items);
  }
  return schema;
}

function buildArrayItems(items: SwaggerParameter | undefined): Record<string, unknown> {
  const itemType = normalizeParameterType(items?.type ?? 'string');
  const schema: Record<string, unknown> = { type: itemType };
  if (Array.isArray(items?.enum) && items.enum.length > 0) schema.enum = items.enum;
  if (itemType === 'array') {
    schema.items = buildArrayItems(items?.items);
  }
  return schema;
}

function normalizeParameterType(type: string): string {
  switch (type) {
    case 'integer':
    case 'number':
    case 'boolean':
    case 'array':
      return type;
    default:
      return 'string';
  }
}

function buildNamespace(path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .filter((part) => !part.startsWith('{'))
    .map((part) => sanitizeSegment(part));
  if (parts.length === 0) return 'esi_misc';
  const prefix = parts[0];
  const scope = parts[1] ?? 'root';
  const detail = parts[2] ?? null;
  const values = detail && scope === 'ui'
    ? [prefix, scope, detail]
    : [prefix, scope];
  return `esi_${values.join('_')}`;
}

function planHostedNamespace(operation: EsiOperationMeta): EsiNamespaceMeta {
  const key = operation.namespace;
  const split = planSpecialHostedNamespace(key, operation);
  if (split) {
    return {
      name: split.name,
      description: split.description,
      tools: [],
    };
  }
  const mapped = HOSTED_NAMESPACE_OVERRIDES[key];
  if (mapped) {
    return {
      name: mapped.name,
      description: mapped.description,
      tools: [],
    };
  }

  return {
    name: key.replace(/^esi_/, 'eve_'),
    description: describeGenericNamespace(key, operation),
    tools: [],
  };
}

const UNIVERSE_CONSOLIDATED: Record<string, { name: string; description: string }> = {
  esi_universe_systems: { name: 'eve_universe_geography', description: 'Public universe geography: systems, constellations, regions, stargates from live EVE ESI.' },
  esi_universe_constellations: { name: 'eve_universe_geography', description: 'Public universe geography: systems, constellations, regions, stargates from live EVE ESI.' },
  esi_universe_regions: { name: 'eve_universe_geography', description: 'Public universe geography: systems, constellations, regions, stargates from live EVE ESI.' },
  esi_universe_stargates: { name: 'eve_universe_geography', description: 'Public universe geography: systems, constellations, regions, stargates from live EVE ESI.' },
  esi_universe_stars: { name: 'eve_universe_celestials', description: 'Detailed info on celestial objects: star luminosity, planet type, moon orbit, station services, structure info. Use for live celestial data not in SDE.' },
  esi_universe_planets: { name: 'eve_universe_celestials', description: 'Detailed info on celestial objects: star luminosity, planet type, moon orbit, station services, structure info. Use for live celestial data not in SDE.' },
  esi_universe_moons: { name: 'eve_universe_celestials', description: 'Detailed info on celestial objects: star luminosity, planet type, moon orbit, station services, structure info. Use for live celestial data not in SDE.' },
  esi_universe_asteroid_belts: { name: 'eve_universe_celestials', description: 'Detailed info on celestial objects: star luminosity, planet type, moon orbit, station services, structure info. Use for live celestial data not in SDE.' },
  esi_universe_stations: { name: 'eve_universe_celestials', description: 'Detailed info on celestial objects: star luminosity, planet type, moon orbit, station services, structure info. Use for live celestial data not in SDE.' },
  esi_universe_structures: { name: 'eve_universe_celestials', description: 'Detailed info on celestial objects: star luminosity, planet type, moon orbit, station services, structure info. Use for live celestial data not in SDE.' },
  esi_universe_types: { name: 'eve_universe_types', description: 'Live type/group/category lookups and PI schematics. Prefer sde_sql for static data; use this only for schematics or data not in SDE.' },
  esi_universe_groups: { name: 'eve_universe_types', description: 'Live type/group/category lookups and PI schematics. Prefer sde_sql for static data; use this only for schematics or data not in SDE.' },
  esi_universe_categories: { name: 'eve_universe_types', description: 'Live type/group/category lookups and PI schematics. Prefer sde_sql for static data; use this only for schematics or data not in SDE.' },
  esi_universe_graphics: { name: 'eve_universe_types', description: 'Live type/group/category lookups and PI schematics. Prefer sde_sql for static data; use this only for schematics or data not in SDE.' },
  esi_universe_schematics: { name: 'eve_universe_types', description: 'Live type/group/category lookups and PI schematics. Prefer sde_sql for static data; use this only for schematics or data not in SDE.' },
  esi_universe_ancestries: { name: 'eve_universe_reference', description: 'Resolve EVE names↔IDs (characters, corps, alliances, systems). Also ancestries, bloodlines, factions. Use post_universe_names for bulk ID→name.' },
  esi_universe_bloodlines: { name: 'eve_universe_reference', description: 'Resolve EVE names↔IDs (characters, corps, alliances, systems). Also ancestries, bloodlines, factions. Use post_universe_names for bulk ID→name.' },
  esi_universe_factions: { name: 'eve_universe_reference', description: 'Resolve EVE names↔IDs (characters, corps, alliances, systems). Also ancestries, bloodlines, factions. Use post_universe_names for bulk ID→name.' },
  esi_universe_races: { name: 'eve_universe_reference', description: 'Resolve EVE names↔IDs (characters, corps, alliances, systems). Also ancestries, bloodlines, factions. Use post_universe_names for bulk ID→name.' },
  esi_universe_names: { name: 'eve_universe_reference', description: 'Resolve EVE names↔IDs (characters, corps, alliances, systems). Also ancestries, bloodlines, factions. Use post_universe_names for bulk ID→name.' },
  esi_universe_ids: { name: 'eve_universe_reference', description: 'Resolve EVE names↔IDs (characters, corps, alliances, systems). Also ancestries, bloodlines, factions. Use post_universe_names for bulk ID→name.' },
};

function planSpecialHostedNamespace(
  key: string,
  _operation: EsiOperationMeta,
): { name: string; description: string } | null {
  const universeGroup = UNIVERSE_CONSOLIDATED[key];
  if (universeGroup) return universeGroup;

  if (key === 'esi_characters_contacts') {
    return {
      name: 'eve_character_contacts',
      description: 'Character contacts and labels (friends, enemies, standings). Use when user asks about their contact list or wants to add/remove contacts.',
    };
  }
  if (key === 'esi_characters_notifications') {
    return {
      name: 'eve_character_notifications',
      description: 'In-game notifications: war declarations, structure alerts, sovereignty changes, corp actions. Use when user asks about alerts or notifications.',
    };
  }
  if (key === 'esi_characters_calendar') {
    return {
      name: 'eve_character_calendar',
      description: 'Character calendar events and RSVP. Use when user asks about upcoming events, fleet ops, or calendar entries.',
    };
  }
  if (key === 'esi_characters_cspa') {
    return {
      name: 'eve_character_messaging',
      description: 'CSPA charge check for messaging. Use when user asks about communication cost to another character.',
    };
  }

  if (key === 'esi_fleets_root' || key === 'esi_fleets_members') {
    return {
      name: 'eve_fleet_roster',
      description: 'Fleet info: members, ships, solar systems, roles. Add/remove/move fleet members. Use when user asks about their fleet composition.',
    };
  }
  if (key === 'esi_fleets_wings' || key === 'esi_fleets_squads') {
    return {
      name: 'eve_fleet_structure',
      description: 'Fleet wings and squads: create, delete, rename, restructure. Use for fleet organization management.',
    };
  }

  if ([
    'esi_corporations_root',
    'esi_corporations_members',
    'esi_corporations_membertracking',
  ].includes(key)) {
    return {
      name: 'eve_corporation_membership',
      description: 'Corporation member list, member count limit, titles per member, and member tracking (last login, location). Use when user asks about corp members or activity.',
    };
  }
  if ([
    'esi_corporations_roles',
    'esi_corporations_titles',
    'esi_corporations_medals',
  ].includes(key)) {
    return {
      name: 'eve_corporation_roles_titles',
      description: 'Corporation roles, titles, medals, and role change history. Use when user asks about corp permissions or who has director/CEO roles.',
    };
  }
  if ([
    'esi_corporations_contacts',
    'esi_corporations_standings',
  ].includes(key)) {
    return {
      name: 'eve_corporation_contacts_standings',
      description: 'Corporation contact list and NPC standings. Use when user asks about corp diplomacy, standings, or contact management.',
    };
  }

  return null;
}

function describeGenericNamespace(key: string, _operation: EsiOperationMeta): string {
  const parts = key.replace(/^esi_/, '').split('_').filter(Boolean);
  if (parts.length === 0) {
    return 'Live EVE ESI tools.';
  }
  const [scope, ...rest] = parts;
  const subject = rest.length > 0 ? rest.join(' ') : 'operations';
  if (scope === 'characters') {
    return `Bound character ${subject} tools from live EVE ESI.`;
  }
  if (scope === 'corporations') {
    return `Corporation ${subject} tools from live EVE ESI.`;
  }
  if (scope === 'ui') {
    return `In-client UI ${subject} tools from live EVE ESI.`;
  }
  return `Public live EVE ESI tools for ${[scope, ...rest].join(' ')}.`;
}

const HOSTED_NAMESPACE_OVERRIDES: Record<string, { name: string; description: string }> = {
  esi_alliances_contacts: {
    name: 'eve_public_alliances_contacts',
    description: 'Alliance contact list and standings. Use when user asks about alliance diplomacy.',
  },
  esi_alliances_corporations: {
    name: 'eve_public_alliances_corporations',
    description: 'List corporations in an alliance. Use when user asks which corps are in a specific alliance.',
  },
  esi_alliances_icons: {
    name: 'eve_public_alliances_lookup',
    description: 'Alliance info: name, ticker, founder, icon. Use when user asks about an alliance or needs alliance details.',
  },
  esi_alliances_root: {
    name: 'eve_public_alliances_lookup',
    description: 'Alliance info: name, ticker, founder, icon. Use when user asks about an alliance or needs alliance details.',
  },
  esi_characters_affiliation: {
    name: 'eve_public_affiliation_lookup',
    description: 'Bulk character→corporation→alliance lookup. Use to find what corp/alliance a character belongs to.',
  },
  esi_characters_agents_research: {
    name: 'eve_character_research_activity',
    description: 'Agent research, LP balance, personal mining ledger, and NPC standings. Use when user asks about loyalty points, research agents, mining history, or faction standings.',
  },
  esi_characters_assets: {
    name: 'eve_character_assets',
    description: 'Find where character items are stored: list assets across stations and ships, search by name, get item locations. Use when user asks "where is my X" or "what do I have in Jita".',
  },
  esi_characters_attributes: {
    name: 'eve_character_skills',
    description: 'Check trained skills, skill queue, attributes, implants, and jump fatigue. Use when user asks about their skills, training, or what they can fly.',
  },
  esi_characters_blueprints: {
    name: 'eve_character_industry',
    description: 'Character blueprints and manufacturing/research jobs. Use when user asks about their BPOs, BPCs, production status, or running jobs.',
  },
  esi_characters_clones: {
    name: 'eve_character_location',
    description: 'Current location, active ship, jump clones, and home station. Use when user asks "where am I", "what ship", or about their clones.',
  },
  esi_characters_contracts: {
    name: 'eve_character_orders_contracts',
    description: 'Check active/expired market orders and contracts (item exchange, courier, auction). Use when user asks about their sell/buy orders or incoming contracts.',
  },
  esi_characters_corporationhistory: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_fatigue: {
    name: 'eve_character_skills',
    description: 'Check trained skills, skill queue, attributes, implants, and jump fatigue. Use when user asks about their skills, training, or what they can fly.',
  },
  esi_characters_fittings: {
    name: 'eve_character_fittings',
    description: 'Saved ship fittings: list, create, delete. Use when user asks about their saved fits or wants to save/manage fittings.',
  },
  esi_characters_fleet: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_fw: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_implants: {
    name: 'eve_character_skills',
    description: 'Check trained skills, skill queue, attributes, implants, and jump fatigue. Use when user asks about their skills, training, or what they can fly.',
  },
  esi_characters_industry: {
    name: 'eve_character_industry',
    description: 'Character blueprints and manufacturing/research jobs. Use when user asks about their BPOs, BPCs, production status, or running jobs.',
  },
  esi_characters_killmails: {
    name: 'eve_character_killmails',
    description: 'Recent kills and losses for the character. Use when user asks about their killboard, PvP history, or recent deaths.',
  },
  esi_characters_location: {
    name: 'eve_character_location',
    description: 'Current location, active ship, jump clones, and home station. Use when user asks "where am I", "what ship", or about their clones.',
  },
  esi_characters_loyalty: {
    name: 'eve_character_research_activity',
    description: 'Agent research, LP balance, personal mining ledger, and NPC standings. Use when user asks about loyalty points, research agents, mining history, or faction standings.',
  },
  esi_characters_mail: {
    name: 'eve_character_mail',
    description: 'Read, send, and manage EVE mail: inbox, labels, mailing lists. Use when user asks about messages, mail, or wants to send a letter.',
  },
  esi_characters_medals: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_mining: {
    name: 'eve_character_research_activity',
    description: 'Agent research, LP balance, personal mining ledger, and NPC standings. Use when user asks about loyalty points, research agents, mining history, or faction standings.',
  },
  esi_characters_online: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_orders: {
    name: 'eve_character_orders_contracts',
    description: 'Check active/expired market orders and contracts (item exchange, courier, auction). Use when user asks about their sell/buy orders or incoming contracts.',
  },
  esi_characters_planets: {
    name: 'eve_character_planets',
    description: 'Planetary Interaction colonies: list planets, view extractors, factories, routes. Use when user asks about PI, extractors, or colony status.',
  },
  esi_characters_portrait: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_roles: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_root: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_search: {
    name: 'eve_character_search',
    description: 'Search EVE universe by name: characters, corps, alliances, systems, stations, structures. Use when user asks to find someone or something by name.',
  },
  esi_characters_ship: {
    name: 'eve_character_location',
    description: 'Current location, active ship, jump clones, and home station. Use when user asks "where am I", "what ship", or about their clones.',
  },
  esi_characters_skillqueue: {
    name: 'eve_character_skills',
    description: 'Check trained skills, skill queue, attributes, implants, and jump fatigue. Use when user asks about their skills, training, or what they can fly.',
  },
  esi_characters_skills: {
    name: 'eve_character_skills',
    description: 'Check trained skills, skill queue, attributes, implants, and jump fatigue. Use when user asks about their skills, training, or what they can fly.',
  },
  esi_characters_standings: {
    name: 'eve_character_research_activity',
    description: 'Agent research, LP balance, personal mining ledger, and NPC standings. Use when user asks about loyalty points, research agents, mining history, or faction standings.',
  },
  esi_characters_titles: {
    name: 'eve_character_profile',
    description: 'Character public info, corp history, portrait, online status, fleet membership, FW stats, roles, titles, medals. Use for profile lookups or identifying a character.',
  },
  esi_characters_wallet: {
    name: 'eve_character_wallet',
    description: 'Check wallet balance, income/expense journal, and transaction history. Use when user asks about ISK, balance, or recent purchases.',
  },
  esi_contracts_public: {
    name: 'eve_public_contracts',
    description: 'Public contracts in a region: item exchange, courier, auction. Browse items and bids. Use when user asks about public contracts or wants to find deals.',
  },
  esi_corporation_mining: {
    name: 'eve_corporation_industry_contracts',
    description: 'Corporation blueprints, industry jobs, mining observers, and contracts. Use for corp production status, moon mining, or corp contracts.',
  },
  esi_corporations_alliancehistory: {
    name: 'eve_corporation_profile',
    description: 'Corporation public info: alliance history, divisions, FW stats, icons, shareholders, NPC corps list. Use for corp profile or identifying a corporation.',
  },
  esi_corporations_assets: {
    name: 'eve_corporation_assets',
    description: 'Corporation hangars, asset search, container logs. Use when user asks about corp assets or container access history.',
  },
  esi_corporations_blueprints: {
    name: 'eve_corporation_industry_contracts',
    description: 'Corporation blueprints, industry jobs, mining observers, and contracts. Use for corp production status, moon mining, or corp contracts.',
  },
  esi_corporations_containers: {
    name: 'eve_corporation_assets',
    description: 'Corporation hangars, asset search, container logs. Use when user asks about corp assets or container access history.',
  },
  esi_corporations_contracts: {
    name: 'eve_corporation_industry_contracts',
    description: 'Corporation blueprints, industry jobs, mining observers, and contracts. Use for corp production status, moon mining, or corp contracts.',
  },
  esi_corporations_customs_offices: {
    name: 'eve_corporation_structures',
    description: 'Corporation structures (citadels, refineries), customs offices, POSes. Use when user asks about structure status, fuel, reinforcement timers.',
  },
  esi_corporations_divisions: {
    name: 'eve_corporation_profile',
    description: 'Corporation public info: alliance history, divisions, FW stats, icons, shareholders, NPC corps list. Use for corp profile or identifying a corporation.',
  },
  esi_corporations_facilities: {
    name: 'eve_corporation_structures',
    description: 'Corporation structures (citadels, refineries), customs offices, POSes. Use when user asks about structure status, fuel, reinforcement timers.',
  },
  esi_corporations_fw: {
    name: 'eve_corporation_profile',
    description: 'Corporation public info: alliance history, divisions, FW stats, icons, shareholders, NPC corps list. Use for corp profile or identifying a corporation.',
  },
  esi_corporations_icons: {
    name: 'eve_corporation_profile',
    description: 'Corporation public info: alliance history, divisions, FW stats, icons, shareholders, NPC corps list. Use for corp profile or identifying a corporation.',
  },
  esi_corporations_industry: {
    name: 'eve_corporation_industry_contracts',
    description: 'Corporation blueprints, industry jobs, mining observers, and contracts. Use for corp production status, moon mining, or corp contracts.',
  },
  esi_corporations_killmails: {
    name: 'eve_corporation_killmails',
    description: 'Recent corporation kills and losses. Use when user asks about corp killboard or PvP activity.',
  },
  esi_corporations_npccorps: {
    name: 'eve_corporation_profile',
    description: 'Corporation public info: alliance history, divisions, FW stats, icons, shareholders, NPC corps list. Use for corp profile or identifying a corporation.',
  },
  esi_corporations_orders: {
    name: 'eve_corporation_wallet',
    description: 'Corporation wallet divisions, market orders, journal, transactions. Use for corp finances, division balances, or corp order history.',
  },
  esi_corporations_shareholders: {
    name: 'eve_corporation_profile',
    description: 'Corporation public info: alliance history, divisions, FW stats, icons, shareholders, NPC corps list. Use for corp profile or identifying a corporation.',
  },
  esi_corporations_starbases: {
    name: 'eve_corporation_structures',
    description: 'Corporation structures (citadels, refineries), customs offices, POSes. Use when user asks about structure status, fuel, reinforcement timers.',
  },
  esi_corporations_structures: {
    name: 'eve_corporation_structures',
    description: 'Corporation structures (citadels, refineries), customs offices, POSes. Use when user asks about structure status, fuel, reinforcement timers.',
  },
  esi_corporations_wallets: {
    name: 'eve_corporation_wallet',
    description: 'Corporation wallet divisions, market orders, journal, transactions. Use for corp finances, division balances, or corp order history.',
  },
  esi_dogma_attributes: {
    name: 'eve_public_dogma',
    description: 'Live dogma attribute/effect definitions and Abyssal item stats. Prefer sde_sql + sde_dogma_attributes for static lookups; use this for dynamic/mutated items.',
  },
  esi_dogma_dynamic: {
    name: 'eve_public_dogma',
    description: 'Live dogma attribute/effect definitions and Abyssal item stats. Prefer sde_sql + sde_dogma_attributes for static lookups; use this for dynamic/mutated items.',
  },
  esi_dogma_effects: {
    name: 'eve_public_dogma',
    description: 'Live dogma attribute/effect definitions and Abyssal item stats. Prefer sde_sql + sde_dogma_attributes for static lookups; use this for dynamic/mutated items.',
  },
  esi_fw_leaderboards: {
    name: 'eve_public_faction_warfare',
    description: 'Faction Warfare: system control, leaderboards, faction stats, active wars. Use when user asks about FW status or which faction controls a system.',
  },
  esi_fw_stats: {
    name: 'eve_public_faction_warfare',
    description: 'Faction Warfare: system control, leaderboards, faction stats, active wars. Use when user asks about FW status or which faction controls a system.',
  },
  esi_fw_systems: {
    name: 'eve_public_faction_warfare',
    description: 'Faction Warfare: system control, leaderboards, faction stats, active wars. Use when user asks about FW status or which faction controls a system.',
  },
  esi_fw_wars: {
    name: 'eve_public_faction_warfare',
    description: 'Faction Warfare: system control, leaderboards, faction stats, active wars. Use when user asks about FW status or which faction controls a system.',
  },
  esi_incursions_root: {
    name: 'eve_public_incursions',
    description: 'Active Sansha incursions: constellation, staging system, influence. Use when user asks about current incursions.',
  },
  esi_industry_facilities: {
    name: 'eve_public_industry',
    description: 'Industry cost indices per system and NPC station manufacturing slots. Use when user asks where to build cheaply or about system industry activity.',
  },
  esi_industry_systems: {
    name: 'eve_public_industry',
    description: 'Industry cost indices per system and NPC station manufacturing slots. Use when user asks where to build cheaply or about system industry activity.',
  },
  esi_insurance_prices: {
    name: 'eve_public_market_reference',
    description: 'Global average prices, insurance costs, market group tree, regional type list. Use for price estimates, insurance payouts, or market structure.',
  },
  esi_killmails_root: {
    name: 'eve_public_killmails',
    description: 'Fetch full killmail details by ID+hash from ESI. Use to get victim/attacker/items breakdown for a specific killmail.',
  },
  esi_loyalty_stores: {
    name: 'eve_public_loyalty_stores',
    description: 'LP store offers for NPC corporations. Use when user asks what they can buy with loyalty points.',
  },
  esi_markets_groups: {
    name: 'eve_public_market_reference',
    description: 'Global average prices, insurance costs, market group tree, regional type list. Use for price estimates, insurance payouts, or market structure.',
  },
  esi_markets_history: {
    name: 'eve_public_market_orders',
    description: 'Live market orders and price history in a region. Use for current buy/sell orders or price trends over time.',
  },
  esi_markets_orders: {
    name: 'eve_public_market_orders',
    description: 'Live market orders and price history in a region. Use for current buy/sell orders or price trends over time.',
  },
  esi_markets_prices: {
    name: 'eve_public_market_reference',
    description: 'Global average prices, insurance costs, market group tree, regional type list. Use for price estimates, insurance payouts, or market structure.',
  },
  esi_markets_structures: {
    name: 'eve_authenticated_market_structures',
    description: 'Browse market orders inside player-owned structures (citadels, engineering complexes). Use when user asks about structure market or Perimeter trade hub orders.',
  },
  esi_markets_types: {
    name: 'eve_public_market_reference',
    description: 'Global average prices, insurance costs, market group tree, regional type list. Use for price estimates, insurance payouts, or market structure.',
  },
  esi_route_root: {
    name: 'eve_public_routes_status',
    description: 'ESI route between systems, TQ server status, system jump/kill stats. Use for raw route data or cluster health check.',
  },
  esi_sovereignty_campaigns: {
    name: 'eve_public_sovereignty',
    description: 'Nullsec sovereignty: who owns what, active ADM campaigns, ihub/TCU timers. Use when user asks about sov ownership or vulnerability windows.',
  },
  esi_sovereignty_map: {
    name: 'eve_public_sovereignty',
    description: 'Nullsec sovereignty: who owns what, active ADM campaigns, ihub/TCU timers. Use when user asks about sov ownership or vulnerability windows.',
  },
  esi_sovereignty_structures: {
    name: 'eve_public_sovereignty',
    description: 'Nullsec sovereignty: who owns what, active ADM campaigns, ihub/TCU timers. Use when user asks about sov ownership or vulnerability windows.',
  },
  esi_status_root: {
    name: 'eve_public_routes_status',
    description: 'ESI route between systems, TQ server status, system jump/kill stats. Use for raw route data or cluster health check.',
  },
  esi_ui_autopilot: {
    name: 'eve_ui',
    description: 'Open windows in EVE client: set autopilot, open market, contracts, info, or compose mail. Use when user wants to interact with the game UI directly.',
  },
  esi_ui_openwindow: {
    name: 'eve_ui',
    description: 'Open windows in EVE client: set autopilot, open market, contracts, info, or compose mail. Use when user wants to interact with the game UI directly.',
  },
  esi_universe_system_jumps: {
    name: 'eve_public_routes_status',
    description: 'ESI route between systems, TQ server status, system jump/kill stats. Use for raw route data or cluster health check.',
  },
  esi_universe_system_kills: {
    name: 'eve_public_routes_status',
    description: 'ESI route between systems, TQ server status, system jump/kill stats. Use for raw route data or cluster health check.',
  },
  esi_wars_killmails: {
    name: 'eve_public_wars',
    description: 'Active and past wars: aggressors, defenders, allies, war kills. Use when user asks about wars or mutual war targets.',
  },
  esi_wars_root: {
    name: 'eve_public_wars',
    description: 'Active and past wars: aggressors, defenders, allies, war kills. Use when user asks about wars or mutual war targets.',
  },
};

function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function buildDescription(
  method: string,
  path: string,
  operation: SwaggerOperation,
  requiredScopes: string[],
  responseFields: string[] | null,
  bulkSpec: { filterKey: string; description: string } | null = null,
): string {
  const summary = (operation.summary ?? operation.description ?? '').trim();
  const scopeText = requiredScopes.length > 0
    ? ` Requires ${requiredScopes.join(', ')}.`
    : ' Public endpoint.';
  const fieldsText = responseFields && responseFields.length > 0
    ? ` Response fields: ${responseFields.join(', ')}. Use fields to request only the subset you need.`
    : ' Response field projection is unsupported for this endpoint.';
  const bulkText = bulkSpec
    ? ` BULK endpoint: returns all rows from ESI, filtered server-side by filter_ids on key "${bulkSpec.filterKey}". Always supply filter_ids.`
    : '';
  return `${method} ${path}.${summary ? ` ${summary}.` : ''}${scopeText}${fieldsText}${bulkText}`;
}

function buildFieldsParameterDescription(responseFields: string[] | null): string {
  if (!responseFields || responseFields.length === 0) {
    return 'Field projection is unsupported for this endpoint. Pass null.';
  }
  return `Optional top-level response fields to return. Allowed fields: ${responseFields.join(', ')}. Null uses the operation default behavior.`;
}

function extractRequiredScopes(security: Array<Record<string, string[]>> | undefined): string[] {
  const scopes = new Set<string>();
  for (const entry of security ?? []) {
    for (const scopeList of Object.values(entry)) {
      for (const scope of scopeList ?? []) {
        if (typeof scope === 'string' && scope.trim()) {
          scopes.add(scope.trim());
        }
      }
    }
  }
  return [...scopes];
}

function isHttpMethod(value: string): value is EsiOperationMeta['method'] {
  return value === 'GET' || value === 'POST' || value === 'PUT' || value === 'DELETE' || value === 'PATCH';
}
