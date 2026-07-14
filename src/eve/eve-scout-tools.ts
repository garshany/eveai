/**
 * EVE-Scout AI tool definitions — `eve_scout` namespace.
 *
 * 6 deferred tools:
 *   scout_route          — WH-aware routing (A→B, highsec exits, Jove Obs, signature routes)
 *   scout_signatures     — active Thera/Turnur WH connections
 *   scout_observations   — metaliminal storms & space oddities
 *   scout_wormhole_types — WH type encyclopedia
 *   compare_wormhole_types — bounded exact WH type comparison facade
 *   scout_systems        — system search with space-class filter
 */

import type { NativeFunctionTool, NativeNamespaceTool } from '../agent/native-responses.js';

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const EVE_SCOUT_TOOL_NAMES = [
  'scout_route',
  'scout_signatures',
  'scout_observations',
  'scout_wormhole_types',
  'compare_wormhole_types',
  'scout_systems',
] as const;

export type EveScoutToolName = typeof EVE_SCOUT_TOOL_NAMES[number];

export function isEveScoutToolName(name: string): name is EveScoutToolName {
  return (EVE_SCOUT_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const COMPARE_WORMHOLE_TYPES_TOOL: NativeFunctionTool = {
  type: 'function',
  name: 'compare_wormhole_types',
  description:
    'Compare two to eight exact wormhole identifiers using bounded public EVE-Scout data. '
    + 'Returns one stable row per identifier, including explicit not-found rows. '
    + 'Use the broader scout_wormhole_types tool for a single lookup or source/target filtering.',
  strict: true,
  defer_loading: true,
  parameters: {
    type: 'object',
    properties: {
      identifiers: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        items: { type: 'string', pattern: '^[A-Za-z][0-9]{3}$' },
        description: 'Two to eight unique wormhole identifiers, for example ["C140", "A239"].',
      },
    },
    required: ['identifiers'],
    additionalProperties: false,
  },
};

const DEFERRED_EVE_SCOUT_TOOLS: NativeFunctionTool[] = [
  {
    type: 'function',
    name: 'scout_route',
    description:
      'Calculate wormhole-aware routes via EVE-Scout. Includes Thera & Turnur WH shortcuts automatically. '
      + 'mode=route: A→B with WH shortcuts (default). '
      + 'mode=highsec: up to 5 closest highsec exits from any system. '
      + 'mode=jove: 5 nearest Jove Observatories. '
      + 'mode=signatures: routes to all known WH connections from a system. '
      + 'Multi-target: set destinations[] (up to 250) instead of to for batch routing.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Origin system name (e.g. "Jita", "Thera", "J100820").',
        },
        to: {
          type: ['string', 'null'],
          description: 'Destination system name. Required for mode=route single-target.',
        },
        destinations: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Multiple destination system names (up to 250). Use instead of "to" for batch routing.',
        },
        preference: {
          type: ['string', 'null'],
          enum: ['safer', 'shortest', 'shortest-gates', null],
          description: 'Route preference. safer=prefer highsec (default), shortest=minimal jumps, shortest-gates=prefer gates over WHs.',
        },
        mode: {
          type: ['string', 'null'],
          enum: ['route', 'highsec', 'jove', 'signatures', null],
          description: 'Routing mode. Default: route.',
        },
      },
      required: ['from', 'to', 'destinations', 'preference', 'mode'],
      additionalProperties: false,
    },
  },
  COMPARE_WORMHOLE_TYPES_TOOL,
  {
    type: 'function',
    name: 'scout_signatures',
    description:
      'Current active wormhole connections to/from Thera and Turnur from EVE-Scout. '
      + 'Shows entry/exit systems, WH type, max ship size, remaining lifetime, in-game signature IDs. '
      + 'Filter by system_name to check connections for a specific system.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        system_name: {
          type: ['string', 'null'],
          description: 'Filter connections by system name (exact match, case-insensitive). Null = all.',
        },
      },
      required: ['system_name'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'scout_observations',
    description:
      'Active metaliminal storms and space oddities from EVE-Scout. '
      + 'Storm types: Electric, Exotic, Gamma Ray, Plasma Firestorm. '
      + 'Shows: storm type, system, region, hours active, observed in person flag. '
      + 'Useful for PvP (storm effects alter combat), exploration, and route safety.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'scout_wormhole_types',
    description:
      'Wormhole type encyclopedia from EVE-Scout. '
      + 'Returns: mass limits (per-jump & total), lifetime in minutes, mass regeneration, '
      + 'source/target space classes, static possibility, wandering flag. '
      + 'Filter by identifier (e.g. "C140", "K162"), source class (e.g. "c2"), or target class (e.g. "hs"). '
      + 'Use when asked about WH properties, ship fitting for WH travel, or mass calculations.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: ['string', 'null'],
          description: 'WH type name (e.g. "C140", "K162", "A239"). Null = all.',
        },
        source: {
          type: ['string', 'null'],
          description: 'Source space class filter (e.g. "c2", "hs", "ns"). Null = any.',
        },
        target: {
          type: ['string', 'null'],
          description: 'Target space class filter (e.g. "hs", "c5", "ns"). Null = any.',
        },
      },
      required: ['identifier', 'source', 'target'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'scout_systems',
    description:
      'Search EVE systems with space-class filtering via EVE-Scout. '
      + 'Supports wormhole system classes (c1-c6, c12/Thera, c13/shattered). '
      + 'Use for WH system lookups where local SDE data lacks class info.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'System name search string (partial match).',
        },
        space: {
          type: ['string', 'null'],
          enum: ['hs', 'ls', 'ns', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c12', 'c13', null],
          description: 'Exact system-class filter. Null = any class.',
        },
        limit: {
          type: ['integer', 'null'],
          minimum: 1,
          maximum: 25,
          description: 'Max results (1-25, default 10).',
        },
      },
      required: ['query', 'space', 'limit'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Namespace builder
// ---------------------------------------------------------------------------

export function buildEveScoutNamespace(): NativeNamespaceTool {
  return {
    type: 'namespace',
    name: 'eve_scout',
    description:
      'EVE-Scout wormhole navigation intelligence. '
      + 'Use when user asks about: wormhole routes, Thera/Turnur connections, '
      + 'WH-aware shortest paths, closest highsec from null/WH, Jove Observatories, '
      + 'metaliminal storms, space weather effects, '
      + 'wormhole type properties (mass, lifetime, ship size), or WH system searches.',
    tools: DEFERRED_EVE_SCOUT_TOOLS,
  };
}
