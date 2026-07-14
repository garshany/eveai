import type { NativeFunctionTool, NativeNamespaceTool } from '../agent/native-responses.js';

export const EVE_KILL_ANALYTICS_TOOL_NAMES = [
  'doctrine_detect',
  'meta_pulse',
  'killmail_forensics',
  'coalition_graph',
] as const;

export type EveKillAnalyticsToolName = typeof EVE_KILL_ANALYTICS_TOOL_NAMES[number];

export function isEveKillAnalyticsToolName(name: string): name is EveKillAnalyticsToolName {
  return (EVE_KILL_ANALYTICS_TOOL_NAMES as readonly string[]).includes(name);
}

const nullableTimestamp = (description: string): Record<string, unknown> => ({
  type: ['string', 'null'],
  description,
});

const analyticsTools: NativeFunctionTool[] = [
  {
    type: 'function',
    name: 'doctrine_detect',
    description:
      'Identify dominant public loss-fit doctrine families for one character, corporation, or alliance. ' +
      'EVE-KILL-derived observation, not an official roster or doctrine source.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        entity: {
          type: 'integer',
          minimum: 1,
          description: 'Positive public CCP character, corporation, or alliance ID. Resolve names through eve_universe_reference first.',
        },
        type: {
          type: 'string',
          enum: ['character', 'corporation', 'alliance'],
          description: 'Entity kind for the numeric CCP ID.',
        },
        since: nullableTimestamp('Canonical ISO-8601 window start with timezone; set together with until, or null for the upstream 30-day default.'),
        until: nullableTimestamp('Canonical ISO-8601 window end with timezone; set together with since, or null for now.'),
        min_cluster_size: {
          type: ['integer', 'null'],
          minimum: 2,
          maximum: 10_000,
          description: 'Minimum losses in a fit family; null uses the upstream default of 5.',
        },
        include_rookie_ships: {
          type: ['boolean', 'null'],
          description: 'Include corvette losses; null uses false.',
        },
        limit: {
          type: ['integer', 'null'],
          minimum: 1,
          maximum: 30,
          description: 'Maximum doctrine families; null uses 10.',
        },
      },
      required: ['entity', 'type', 'since', 'until', 'min_cluster_size', 'include_rookie_ships', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'meta_pulse',
    description:
      'Scan dominant public loss-fit families across EVE or one region. ' +
      'Use for current observed doctrine meta, including capital and supercapital filters.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        region_id: {
          type: ['integer', 'null'],
          minimum: 1,
          description: 'Optional positive EVE region ID; null scans globally.',
        },
        ship_category: {
          type: ['string', 'null'],
          enum: ['all', 'frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship', 'capital', 'supercap', 'subcap', null],
          description: 'Hull-class filter; null uses all.',
        },
        since: nullableTimestamp('Canonical ISO-8601 window start with timezone; set together with until, or null for the upstream 7-day default.'),
        until: nullableTimestamp('Canonical ISO-8601 window end with timezone; set together with since, or null for now.'),
        min_cluster_size: {
          type: ['integer', 'null'],
          minimum: 1,
          maximum: 10_000,
          description: 'Minimum losses in a fit family; null uses 10.',
        },
        include_rookie_ships: {
          type: ['boolean', 'null'],
          description: 'Include corvette losses; null uses false.',
        },
        limit: {
          type: ['integer', 'null'],
          minimum: 1,
          maximum: 30,
          description: 'Maximum meta families; null uses 15.',
        },
      },
      required: ['region_id', 'ship_category', 'since', 'until', 'min_cluster_size', 'include_rookie_ships', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'killmail_forensics',
    description:
      'Run EVE-KILL public rule-based post-mortem analysis for one killmail: fit dogma, cap, ' +
      'resist weakspots, attacker pressure, and observed doctrine similarity.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        killmail_id: {
          type: 'integer',
          minimum: 1,
          description: 'Positive public EVE killmail ID.',
        },
      },
      required: ['killmail_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'coalition_graph',
    description:
      'Derive a time-windowed alliance co-occurrence graph from public battle teams. ' +
      'Allied/enemy edges are behavioral observations, not official standings.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        since: nullableTimestamp('Canonical ISO-8601 window start with timezone; set together with until, or null for the upstream 30-day default.'),
        until: nullableTimestamp('Canonical ISO-8601 window end with timezone; set together with since, or null for now.'),
        min_edge_weight: {
          type: ['integer', 'null'],
          minimum: 1,
          maximum: 10_000,
          description: 'Minimum shared/opposed battle count per edge; null uses 3.',
        },
        min_alliance_battles: {
          type: ['integer', 'null'],
          minimum: 1,
          maximum: 10_000,
          description: 'Minimum battle count per alliance; null uses 5.',
        },
        focus_alliance: {
          type: ['integer', 'null'],
          minimum: 1,
          description: 'Optional positive public CCP alliance ID for an ego graph. Resolve names through eve_universe_reference first.',
        },
        limit_edges: {
          type: ['integer', 'null'],
          minimum: 1,
          maximum: 500,
          description: 'Maximum returned edges; null uses 100.',
        },
      },
      required: ['since', 'until', 'min_edge_weight', 'min_alliance_battles', 'focus_alliance', 'limit_edges'],
      additionalProperties: false,
    },
  },
];

export function buildEveKillAnalyticsNamespace(): NativeNamespaceTool {
  return {
    type: 'namespace',
    name: 'eve_kill_analytics',
    description:
      'Local public-only wrappers for four EVE-KILL analytics methods. Arguments are validated by the application before a fixed MCP request; no chat history, profile, fit, private ESI data, or credentials are forwarded.',
    tools: analyticsTools,
  };
}
