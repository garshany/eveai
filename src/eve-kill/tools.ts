import type { NativeFunctionTool, NativeNamespaceTool } from '../agent/native-responses.js';

export const EVE_KILL_NAMESPACE_TOOL_NAMES = [
  'kill_search',
  'kill_activity',
  'kill_detail',
  'kill_intel',
  'kill_battles',
  'kill_watch',
] as const;

export const EVE_KILL_TOOL_NAMES = [
  ...EVE_KILL_NAMESPACE_TOOL_NAMES,
  'kill_activity_summary',
] as const;

export type EveKillToolName = typeof EVE_KILL_TOOL_NAMES[number];

export function isEveKillToolName(name: string): name is EveKillToolName {
  return (EVE_KILL_TOOL_NAMES as readonly string[]).includes(name);
}

const tools: NativeFunctionTool[] = [
  {
    type: 'function',
    name: 'kill_search',
    description:
      'Search public killmails observed by EVE-KILL in an explicit time window. ' +
      'This is third-party discovery, not an authoritative CCP record; caps and truncation are returned.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO8601 window start.' },
        to: { type: 'string', description: 'ISO8601 window end.' },
        system_ids: nullableIdArray(),
        constellation_ids: nullableIdArray(),
        region_ids: nullableIdArray(),
        character_ids: nullableIdArray(),
        corporation_ids: nullableIdArray(),
        alliance_ids: nullableIdArray(),
        limit: { type: ['integer', 'null'], description: 'Tool result cap, 1-100.' },
      },
      required: ['from', 'to', 'system_ids', 'constellation_ids', 'region_ids', 'character_ids', 'corporation_ids', 'alliance_ids', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'kill_activity',
    description:
      'List public EVE-KILL activity for one system, character, corporation, or alliance. ' +
      'Kills/losses describe observed killboard roles and may be incomplete.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['system', 'character', 'corporation', 'alliance'] },
        id: { type: 'integer', description: 'CCP entity or solar-system ID.' },
        activity: { type: 'string', enum: ['kills', 'losses', 'all'] },
        from: { type: ['string', 'null'], description: 'Optional ISO8601 lower time bound.' },
        to: { type: ['string', 'null'], description: 'Optional ISO8601 upper time bound.' },
        limit: { type: ['integer', 'null'], description: 'Tool result cap, 1-100.' },
      },
      required: ['scope', 'id', 'activity', 'from', 'to', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'kill_detail',
    description:
      'Read EVE-KILL public detail/value enrichment, slot-grouped fitting, or ID-only hash discovery. ' +
      'Hash discovery is non-authoritative; official detail requires CCP ESI with (id, hash).',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['detail', 'fitting', 'hash_discovery'] },
        killmail_id: { type: 'integer' },
      },
      required: ['action', 'killmail_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'kill_intel',
    description:
      'Read third-party EVE-KILL character aggregates, killmail-derived public intel, or public leaderboards. ' +
      'These observations are not authoritative identity, affiliation, history, or roster data.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['character_stats', 'character_intel', 'leaderboard'] },
        character_id: { type: ['integer', 'null'] },
        period: { type: ['string', 'null'], enum: ['alltime', 'weekly', null] },
        days: { type: ['integer', 'null'] },
        data_type: {
          type: ['string', 'null'],
          enum: ['characters', 'corporations', 'alliances', 'ships', 'systems', 'regions', 'solo_killers', 'dangerous_systems', 'deadliest_regions', 'most_valuable_ships', 'most_valuable_structures', null],
        },
        limit: { type: ['integer', 'null'], description: 'Leaderboard row cap, 1-100.' },
      },
      required: ['action', 'character_id', 'period', 'days', 'data_type', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'kill_battles',
    description: 'List or inspect public battle clusters computed by EVE-KILL. Battle grouping is third-party derived.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'detail'] },
        battle_id: { type: ['integer', 'null'] },
        page: { type: ['integer', 'null'] },
        limit: { type: ['integer', 'null'], minimum: 1, maximum: 100, description: 'List row cap or detail member cap, 1-100.' },
        sort: { type: ['string', 'null'], enum: ['battle_id', 'total_isk_destroyed', 'kill_count', 'start_time', null] },
      },
      required: ['action', 'battle_id', 'page', 'limit', 'sort'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'kill_watch',
    description: 'Manage durable EVE-KILL public feed alerts for system, region, victim, or attacker topics.',
    strict: false,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['watch', 'unwatch', 'unwatch_all', 'list'] },
        topic_type: { type: 'string', enum: ['victim', 'attacker', 'system', 'region'] },
        topic_id: { type: 'integer' },
        label: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

export const KILL_ACTIVITY_SUMMARY_TOOL: NativeFunctionTool = {
  type: 'function',
  name: 'kill_activity_summary',
  description:
    'Summarize at most 100 public EVE-KILL observations for one system, character, corporation, or alliance ' +
    'in an explicit window of at most seven days. Returns compact aggregates, coverage, provenance, and bounded ' +
    'evidence IDs only; never raw killmail rows, hashes, participants, fits, items, positions, or private ESI data.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['system', 'character', 'corporation', 'alliance'] },
      id: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: 'Positive public CCP entity or solar-system ID.',
      },
      activity: { type: 'string', enum: ['kills', 'losses', 'all'] },
      from: { type: 'string', description: 'Canonical UTC ISO-8601 window start.' },
      to: { type: 'string', description: 'Canonical UTC ISO-8601 window end, strictly after from.' },
      evidence_limit: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: 10,
        description: 'Evidence ID cap. null means 5; programmatic calls are limited to 5.',
      },
    },
    required: ['scope', 'id', 'activity', 'from', 'to', 'evidence_limit'],
    additionalProperties: false,
  },
};

export function buildEveKillNamespace(
  options: { includeWatch?: boolean } = {},
): NativeNamespaceTool {
  const includeWatch = options.includeWatch !== false;
  return {
    type: 'namespace',
    name: 'eve_kill',
    description:
      'Third-party public kill discovery, aggregates, battle clusters, fittings/value enrichment, ' +
      `non-authoritative hash discovery${includeWatch ? ', and feed watches' : ''} from EVE-KILL. Use official ESI for identity, ` +
      'affiliation, history, wars, rosters, and official killmail detail; use local SDE for static data.',
    tools: !includeWatch
      ? tools.filter((tool) => tool.name !== 'kill_watch')
      : tools,
  };
}

function nullableIdArray(): Record<string, unknown> {
  return {
    type: ['array', 'null'],
    items: { type: 'integer' },
    maxItems: 3_840,
    description: 'Optional CCP IDs; the client chunks each upstream request to at most 15.',
  };
}
