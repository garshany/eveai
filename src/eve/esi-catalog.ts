import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const EXCLUDED_OPERATIONS = new Set([
  'get_universe_systems',        // ~8500 IDs, available in SDE
  'get_universe_types',          // ~51000 IDs, available in SDE
  'get_universe_categories',     // available in SDE
  'get_universe_groups',         // available in SDE
  'get_universe_constellations', // available in SDE
  'get_universe_regions',        // available in SDE
  'get_universe_ancestries',     // available in SDE
  'get_universe_bloodlines',     // available in SDE
  'get_universe_factions',       // available in SDE
  'get_universe_graphics',       // available in SDE
  'get_universe_races',          // available in SDE
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
    if (!existsSync(cachePath)) {
      throw new Error(`ESI swagger cache is missing: ${cachePath}`);
    }
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as SwaggerSpec;
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
      writeCache(cachePath, JSON.stringify(json));
      return json;
    }
  } catch {
    // fall back to local cache
  }

  if (!existsSync(cachePath)) {
    throw new Error(`ESI swagger cache is missing: ${cachePath}`);
  }
  return JSON.parse(readFileSync(cachePath, 'utf-8')) as SwaggerSpec;
}

function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

function writeCache(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
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
  esi_universe_stars: { name: 'eve_universe_celestials', description: 'Public universe celestials: stars, planets, moons, belts, stations, structures from live EVE ESI.' },
  esi_universe_planets: { name: 'eve_universe_celestials', description: 'Public universe celestials: stars, planets, moons, belts, stations, structures from live EVE ESI.' },
  esi_universe_moons: { name: 'eve_universe_celestials', description: 'Public universe celestials: stars, planets, moons, belts, stations, structures from live EVE ESI.' },
  esi_universe_asteroid_belts: { name: 'eve_universe_celestials', description: 'Public universe celestials: stars, planets, moons, belts, stations, structures from live EVE ESI.' },
  esi_universe_stations: { name: 'eve_universe_celestials', description: 'Public universe celestials: stars, planets, moons, belts, stations, structures from live EVE ESI.' },
  esi_universe_structures: { name: 'eve_universe_celestials', description: 'Public universe celestials: stars, planets, moons, belts, stations, structures from live EVE ESI.' },
  esi_universe_types: { name: 'eve_universe_types', description: 'Public universe type reference: types, groups, categories, graphics, schematics from live EVE ESI.' },
  esi_universe_groups: { name: 'eve_universe_types', description: 'Public universe type reference: types, groups, categories, graphics, schematics from live EVE ESI.' },
  esi_universe_categories: { name: 'eve_universe_types', description: 'Public universe type reference: types, groups, categories, graphics, schematics from live EVE ESI.' },
  esi_universe_graphics: { name: 'eve_universe_types', description: 'Public universe type reference: types, groups, categories, graphics, schematics from live EVE ESI.' },
  esi_universe_schematics: { name: 'eve_universe_types', description: 'Public universe type reference: types, groups, categories, graphics, schematics from live EVE ESI.' },
  esi_universe_ancestries: { name: 'eve_universe_reference', description: 'Public universe reference: ancestries, bloodlines, factions, races, name/ID resolution from live EVE ESI.' },
  esi_universe_bloodlines: { name: 'eve_universe_reference', description: 'Public universe reference: ancestries, bloodlines, factions, races, name/ID resolution from live EVE ESI.' },
  esi_universe_factions: { name: 'eve_universe_reference', description: 'Public universe reference: ancestries, bloodlines, factions, races, name/ID resolution from live EVE ESI.' },
  esi_universe_races: { name: 'eve_universe_reference', description: 'Public universe reference: ancestries, bloodlines, factions, races, name/ID resolution from live EVE ESI.' },
  esi_universe_names: { name: 'eve_universe_reference', description: 'Public universe reference: ancestries, bloodlines, factions, races, name/ID resolution from live EVE ESI.' },
  esi_universe_ids: { name: 'eve_universe_reference', description: 'Public universe reference: ancestries, bloodlines, factions, races, name/ID resolution from live EVE ESI.' },
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
      description: 'Bound character contact and contact label tools from live EVE ESI.',
    };
  }
  if (key === 'esi_characters_notifications') {
    return {
      name: 'eve_character_notifications',
      description: 'Bound character notification tools from live EVE ESI.',
    };
  }
  if (key === 'esi_characters_calendar') {
    return {
      name: 'eve_character_calendar',
      description: 'Bound character calendar and calendar event tools from live EVE ESI.',
    };
  }
  if (key === 'esi_characters_cspa') {
    return {
      name: 'eve_character_messaging',
      description: 'Bound character messaging and communication setting tools from live EVE ESI.',
    };
  }

  if (key === 'esi_fleets_root' || key === 'esi_fleets_members') {
    return {
      name: 'eve_fleet_roster',
      description: 'Fleet details and fleet member roster tools from live EVE ESI.',
    };
  }
  if (key === 'esi_fleets_wings' || key === 'esi_fleets_squads') {
    return {
      name: 'eve_fleet_structure',
      description: 'Fleet wing and squad structure tools from live EVE ESI.',
    };
  }

  if ([
    'esi_corporations_root',
    'esi_corporations_members',
    'esi_corporations_membertracking',
  ].includes(key)) {
    return {
      name: 'eve_corporation_membership',
      description: 'Corporation membership, roster, and member-tracking tools from live EVE ESI.',
    };
  }
  if ([
    'esi_corporations_roles',
    'esi_corporations_titles',
    'esi_corporations_medals',
  ].includes(key)) {
    return {
      name: 'eve_corporation_roles_titles',
      description: 'Corporation roles, titles, and medal management tools from live EVE ESI.',
    };
  }
  if ([
    'esi_corporations_contacts',
    'esi_corporations_standings',
  ].includes(key)) {
    return {
      name: 'eve_corporation_contacts_standings',
      description: 'Corporation contacts and standings tools from live EVE ESI.',
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
    description: 'Public alliance contacts and standings tools from live EVE ESI.',
  },
  esi_alliances_corporations: {
    name: 'eve_public_alliances_corporations',
    description: 'Public alliance corporation membership tools from live EVE ESI.',
  },
  esi_alliances_icons: {
    name: 'eve_public_alliances_lookup',
    description: 'Public alliance identity and icon lookup tools from live EVE ESI.',
  },
  esi_alliances_root: {
    name: 'eve_public_alliances_lookup',
    description: 'Public alliance identity and icon lookup tools from live EVE ESI.',
  },
  esi_characters_affiliation: {
    name: 'eve_public_affiliation_lookup',
    description: 'Public character affiliation lookup tools from live EVE ESI.',
  },
  esi_characters_agents_research: {
    name: 'eve_character_research_activity',
    description: 'Bound character research, loyalty, mining, and related activity tools from live EVE ESI.',
  },
  esi_characters_assets: {
    name: 'eve_character_assets',
    description: 'Bound character asset listing, asset names, and asset location tools from live EVE ESI.',
  },
  esi_characters_attributes: {
    name: 'eve_character_skills',
    description: 'Bound character skills, attributes, implants, and fatigue tools from live EVE ESI.',
  },
  esi_characters_blueprints: {
    name: 'eve_character_industry',
    description: 'Bound character industry, blueprint, and related production tools from live EVE ESI.',
  },
  esi_characters_clones: {
    name: 'eve_character_location',
    description: 'Bound character location, ship, clone, and home-station tools from live EVE ESI.',
  },
  esi_characters_contracts: {
    name: 'eve_character_orders_contracts',
    description: 'Bound character market order and contract tools from live EVE ESI.',
  },
  esi_characters_corporationhistory: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and affiliation history tools from live EVE ESI.',
  },
  esi_characters_fatigue: {
    name: 'eve_character_skills',
    description: 'Bound character skills, attributes, implants, and fatigue tools from live EVE ESI.',
  },
  esi_characters_fittings: {
    name: 'eve_character_fittings',
    description: 'Bound character fitting tools from live EVE ESI.',
  },
  esi_characters_fleet: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and fleet-affiliation tools from live EVE ESI.',
  },
  esi_characters_fw: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and faction warfare tools from live EVE ESI.',
  },
  esi_characters_implants: {
    name: 'eve_character_skills',
    description: 'Bound character skills, attributes, implants, and fatigue tools from live EVE ESI.',
  },
  esi_characters_industry: {
    name: 'eve_character_industry',
    description: 'Bound character industry, blueprint, and related production tools from live EVE ESI.',
  },
  esi_characters_killmails: {
    name: 'eve_character_killmails',
    description: 'Bound character killmail index and killmail detail tools from live EVE ESI.',
  },
  esi_characters_location: {
    name: 'eve_character_location',
    description: 'Bound character location, ship, clone, and home-station tools from live EVE ESI.',
  },
  esi_characters_loyalty: {
    name: 'eve_character_research_activity',
    description: 'Bound character research, loyalty, mining, and related activity tools from live EVE ESI.',
  },
  esi_characters_mail: {
    name: 'eve_character_mail',
    description: 'Bound character mail and messaging tools from live EVE ESI.',
  },
  esi_characters_medals: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and award tools from live EVE ESI.',
  },
  esi_characters_mining: {
    name: 'eve_character_research_activity',
    description: 'Bound character research, loyalty, mining, and related activity tools from live EVE ESI.',
  },
  esi_characters_online: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and online status tools from live EVE ESI.',
  },
  esi_characters_orders: {
    name: 'eve_character_orders_contracts',
    description: 'Bound character market order and contract tools from live EVE ESI.',
  },
  esi_characters_planets: {
    name: 'eve_character_planets',
    description: 'Bound character planetary interaction tools from live EVE ESI.',
  },
  esi_characters_portrait: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and portrait tools from live EVE ESI.',
  },
  esi_characters_roles: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and role tools from live EVE ESI.',
  },
  esi_characters_root: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and affiliation history tools from live EVE ESI.',
  },
  esi_characters_search: {
    name: 'eve_character_search',
    description: 'Bound character directory and structure-aware search tools from live EVE ESI.',
  },
  esi_characters_ship: {
    name: 'eve_character_location',
    description: 'Bound character location, ship, clone, and home-station tools from live EVE ESI.',
  },
  esi_characters_skillqueue: {
    name: 'eve_character_skills',
    description: 'Bound character skills, attributes, implants, and fatigue tools from live EVE ESI.',
  },
  esi_characters_skills: {
    name: 'eve_character_skills',
    description: 'Bound character skills, attributes, implants, and fatigue tools from live EVE ESI.',
  },
  esi_characters_standings: {
    name: 'eve_character_research_activity',
    description: 'Bound character research, loyalty, mining, and related activity tools from live EVE ESI.',
  },
  esi_characters_titles: {
    name: 'eve_character_profile',
    description: 'Bound character identity, profile, and award tools from live EVE ESI.',
  },
  esi_characters_wallet: {
    name: 'eve_character_wallet',
    description: 'Bound character wallet balance, journal, and transaction tools from live EVE ESI.',
  },
  esi_contracts_public: {
    name: 'eve_public_contracts',
    description: 'Public contract listing, bids, and contract item tools from live EVE ESI.',
  },
  esi_corporation_mining: {
    name: 'eve_corporation_industry_contracts',
    description: 'Corporation blueprints, industry, mining observer, and contract tools from live EVE ESI.',
  },
  esi_corporations_alliancehistory: {
    name: 'eve_corporation_profile',
    description: 'Corporation profile, affiliation, and reference tools from live EVE ESI.',
  },
  esi_corporations_assets: {
    name: 'eve_corporation_assets',
    description: 'Corporation asset listing, asset names, and asset location tools from live EVE ESI.',
  },
  esi_corporations_blueprints: {
    name: 'eve_corporation_industry_contracts',
    description: 'Corporation blueprints, industry, mining observer, and contract tools from live EVE ESI.',
  },
  esi_corporations_containers: {
    name: 'eve_corporation_assets',
    description: 'Corporation asset listing, asset names, and asset location tools from live EVE ESI.',
  },
  esi_corporations_contracts: {
    name: 'eve_corporation_industry_contracts',
    description: 'Corporation blueprints, industry, mining observer, and contract tools from live EVE ESI.',
  },
  esi_corporations_customs_offices: {
    name: 'eve_corporation_structures',
    description: 'Corporation structures, customs offices, facilities, and starbase tools from live EVE ESI.',
  },
  esi_corporations_divisions: {
    name: 'eve_corporation_profile',
    description: 'Corporation profile, affiliation, and reference tools from live EVE ESI.',
  },
  esi_corporations_facilities: {
    name: 'eve_corporation_structures',
    description: 'Corporation structures, customs offices, facilities, and starbase tools from live EVE ESI.',
  },
  esi_corporations_fw: {
    name: 'eve_corporation_profile',
    description: 'Corporation profile, affiliation, and faction warfare tools from live EVE ESI.',
  },
  esi_corporations_icons: {
    name: 'eve_corporation_profile',
    description: 'Corporation profile, affiliation, and reference tools from live EVE ESI.',
  },
  esi_corporations_industry: {
    name: 'eve_corporation_industry_contracts',
    description: 'Corporation blueprints, industry, mining observer, and contract tools from live EVE ESI.',
  },
  esi_corporations_killmails: {
    name: 'eve_corporation_killmails',
    description: 'Corporation killmail index and killmail detail tools from live EVE ESI.',
  },
  esi_corporations_npccorps: {
    name: 'eve_corporation_profile',
    description: 'Corporation profile, affiliation, and reference tools from live EVE ESI.',
  },
  esi_corporations_orders: {
    name: 'eve_corporation_wallet',
    description: 'Corporation wallet, order, and finance tools from live EVE ESI.',
  },
  esi_corporations_shareholders: {
    name: 'eve_corporation_profile',
    description: 'Corporation profile, affiliation, and reference tools from live EVE ESI.',
  },
  esi_corporations_starbases: {
    name: 'eve_corporation_structures',
    description: 'Corporation structures, customs offices, facilities, and starbase tools from live EVE ESI.',
  },
  esi_corporations_structures: {
    name: 'eve_corporation_structures',
    description: 'Corporation structures, customs offices, facilities, and starbase tools from live EVE ESI.',
  },
  esi_corporations_wallets: {
    name: 'eve_corporation_wallet',
    description: 'Corporation wallet, order, and finance tools from live EVE ESI.',
  },
  esi_dogma_attributes: {
    name: 'eve_public_dogma',
    description: 'Public live EVE ESI dogma and dynamic attribute reference tools.',
  },
  esi_dogma_dynamic: {
    name: 'eve_public_dogma',
    description: 'Public live EVE ESI dogma and dynamic attribute reference tools.',
  },
  esi_dogma_effects: {
    name: 'eve_public_dogma',
    description: 'Public live EVE ESI dogma and dynamic attribute reference tools.',
  },
  esi_fw_leaderboards: {
    name: 'eve_public_faction_warfare',
    description: 'Public faction warfare stats, systems, and leaderboard tools from live EVE ESI.',
  },
  esi_fw_stats: {
    name: 'eve_public_faction_warfare',
    description: 'Public faction warfare stats, systems, and leaderboard tools from live EVE ESI.',
  },
  esi_fw_systems: {
    name: 'eve_public_faction_warfare',
    description: 'Public faction warfare stats, systems, and leaderboard tools from live EVE ESI.',
  },
  esi_fw_wars: {
    name: 'eve_public_faction_warfare',
    description: 'Public faction warfare stats, systems, and leaderboard tools from live EVE ESI.',
  },
  esi_incursions_root: {
    name: 'eve_public_incursions',
    description: 'Public incursion status tools from live EVE ESI.',
  },
  esi_industry_facilities: {
    name: 'eve_public_industry',
    description: 'Public live EVE ESI industry systems and facility reference tools.',
  },
  esi_industry_systems: {
    name: 'eve_public_industry',
    description: 'Public live EVE ESI industry systems and facility reference tools.',
  },
  esi_insurance_prices: {
    name: 'eve_public_market_reference',
    description: 'Public market prices, insurance, and market reference tools from live EVE ESI.',
  },
  esi_killmails_root: {
    name: 'eve_public_killmails',
    description: 'Public killmail detail lookup tools from live EVE ESI.',
  },
  esi_loyalty_stores: {
    name: 'eve_public_loyalty_stores',
    description: 'Public loyalty store offer and reference tools from live EVE ESI.',
  },
  esi_markets_groups: {
    name: 'eve_public_market_reference',
    description: 'Public market prices, insurance, and market reference tools from live EVE ESI.',
  },
  esi_markets_history: {
    name: 'eve_public_market_orders',
    description: 'Public regional market order and history tools from live EVE ESI.',
  },
  esi_markets_orders: {
    name: 'eve_public_market_orders',
    description: 'Public regional market order and history tools from live EVE ESI.',
  },
  esi_markets_prices: {
    name: 'eve_public_market_reference',
    description: 'Public market prices, insurance, and market reference tools from live EVE ESI.',
  },
  esi_markets_structures: {
    name: 'eve_authenticated_market_structures',
    description: 'Authenticated structure market order tools from live EVE ESI.',
  },
  esi_markets_types: {
    name: 'eve_public_market_reference',
    description: 'Public market prices, insurance, and market reference tools from live EVE ESI.',
  },
  esi_route_root: {
    name: 'eve_public_routes_status',
    description: 'Public route planning, cluster status, and system traffic tools from live EVE ESI.',
  },
  esi_sovereignty_campaigns: {
    name: 'eve_public_sovereignty',
    description: 'Public sovereignty campaign, structure, and map tools from live EVE ESI.',
  },
  esi_sovereignty_map: {
    name: 'eve_public_sovereignty',
    description: 'Public sovereignty campaign, structure, and map tools from live EVE ESI.',
  },
  esi_sovereignty_structures: {
    name: 'eve_public_sovereignty',
    description: 'Public sovereignty campaign, structure, and map tools from live EVE ESI.',
  },
  esi_status_root: {
    name: 'eve_public_routes_status',
    description: 'Public route planning, cluster status, and system traffic tools from live EVE ESI.',
  },
  esi_ui_autopilot: {
    name: 'eve_ui',
    description: 'In-client UI actions such as autopilot and window control from live EVE ESI.',
  },
  esi_ui_openwindow: {
    name: 'eve_ui',
    description: 'In-client UI actions such as autopilot and window control from live EVE ESI.',
  },
  esi_universe_system_jumps: {
    name: 'eve_public_routes_status',
    description: 'Public route planning, cluster status, and system traffic tools from live EVE ESI.',
  },
  esi_universe_system_kills: {
    name: 'eve_public_routes_status',
    description: 'Public route planning, cluster status, and system traffic tools from live EVE ESI.',
  },
  esi_wars_killmails: {
    name: 'eve_public_wars',
    description: 'Public war list, war detail, and war killmail tools from live EVE ESI.',
  },
  esi_wars_root: {
    name: 'eve_public_wars',
    description: 'Public war list, war detail, and war killmail tools from live EVE ESI.',
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
