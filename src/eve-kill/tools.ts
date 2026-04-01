/**
 * EVE-KILL tool definitions for the agent namespace system.
 *
 * Design: each tool covers a logical domain with only the params it needs.
 * This keeps descriptions focused for tool_search and avoids null-param waste.
 */

import type { NativeFunctionTool, NativeNamespaceTool } from '../agent/native-responses.js';
import { KILL_FEED_RESPONSE_FIELDS } from './feed.js';

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const EVE_KILL_TOOL_NAMES = [
  'kill_feed', 'kill_query',
  'kill_stats', 'kill_battles', 'kill_entity',
  'kill_lookup', 'kill_spatial', 'kill_prices',
  'kill_watch',
] as const;

export type EveKillToolName = typeof EVE_KILL_TOOL_NAMES[number];

export function isEveKillToolName(name: string): name is EveKillToolName {
  return (EVE_KILL_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const QUERY_FIELDS_REF = `Filterable fields (MongoDB-style):
killmail_id, kill_time (unix seconds!), system_id, region_id,
total_value, fitted_value, dropped_value, destroyed_value, point_value,
victim.character_id, victim.corporation_id, victim.alliance_id, victim.ship_type_id,
attackers.character_id, attackers.corporation_id, attackers.alliance_id, attackers.ship_type_id,
is_npc, is_solo, is_awox, labels.
Operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or.
kill_time = unix seconds. Sort default: {"kill_time":-1}. Max limit: 100.`;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const DEFERRED_EVE_KILL_TOOLS: NativeFunctionTool[] = [

  // ── kill_feed ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_feed',
    description:
      'Recent killmails from EVE-KILL by system, character, corporation, alliance, or ship type. ' +
      'Pre-enriched with names/values (no ESI needed). ' +
      `Response fields: ${KILL_FEED_RESPONSE_FIELDS.join(', ')}. ` +
      'Always pass fields to select only what you need.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['system', 'character', 'corporation', 'alliance', 'ship_type'],
          description: 'Query target: system_id, character_id, corporation_id, alliance_id, or ship type_id.',
        },
        id: { type: 'integer', description: 'CCP ID matching scope. Resolve via sde_sql first.' },
        activity: {
          type: ['string', 'null'], enum: ['kills', 'losses', 'all', null],
          description: 'kills=attacker, losses=victim, all=both (default). Ignored for system.',
        },
        past_seconds: { type: ['integer', 'null'], description: 'Time window. Defaults: system 3600, entity 86400, ship 604800. Max 2592000.' },
        limit: { type: ['integer', 'null'], description: 'Max killmails (1-50, default 10).' },
        detail_limit: { type: ['integer', 'null'], description: 'Killmails with full details (0-20, default min(limit,10)). Lower saves tokens.' },
        fields: {
          type: ['array', 'null'],
          items: { type: 'string', enum: [...KILL_FEED_RESPONSE_FIELDS] },
          description: 'Select response fields. Null = all.',
        },
      },
      required: ['scope', 'id', 'activity', 'past_seconds', 'limit', 'detail_limit', 'fields'],
      additionalProperties: false,
    },
  },

  // ── kill_query ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_query',
    description:
      'Advanced killmail search with MongoDB-style filters. ' +
      'For queries kill_feed cannot express: ISK thresholds, multi-entity, labels, regex, $or/$and combos. ' +
      `\n${QUERY_FIELDS_REF}`,
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'JSON string of MongoDB-style filter. Example: {"total_value":{"$gte":1000000000},"region_id":10000060}' },
        sort: { type: ['string', 'null'], description: 'JSON string of sort spec. Default: {"kill_time":-1}. Example: {"total_value":-1}.' },
        limit: { type: ['integer', 'null'], description: 'Max results (1-100, default 20).' },
        fields: {
          type: ['array', 'null'],
          items: { type: 'string', enum: [...KILL_FEED_RESPONSE_FIELDS] },
          description: 'Response field subset. Null = all.',
        },
      },
      required: ['filter', 'sort', 'limit', 'fields'],
      additionalProperties: false,
    },
  },

  // ── kill_stats ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_stats',
    description:
      'PvP statistics and rankings for a character, corporation, or alliance from EVE-KILL. ' +
      'Stats include kills, losses, ISK destroyed/lost, solo kills. Top lists rank by ships/systems/regions. ' +
      'Global leaderboards: most valuable kills, top killers, active corps, etc.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['stats', 'shortstats', 'top', 'global_stats'],
          description: 'stats=full PvP stats, shortstats=compact, top=rankings by ships/systems/regions, global_stats=server leaderboards.',
        },
        scope: {
          type: ['string', 'null'], enum: ['character', 'corporation', 'alliance', null],
          description: 'Entity type. Required for stats/shortstats/top. Null for global_stats.',
        },
        id: { type: ['integer', 'null'], description: 'Entity ID. Required for stats/shortstats/top.' },
        top_type: {
          type: ['string', 'null'], enum: ['ships', 'systems', 'regions', null],
          description: 'For top: what to rank. For global_stats: category (characters|corporations|alliances|ships|solo|most_valuable_kills|most_valuable_structures|kill_count|new_characters).',
        },
        days: { type: ['integer', 'null'], description: '0=all-time, default 7.' },
        limit: { type: ['integer', 'null'], description: 'For global_stats: 1-100, default 10.' },
      },
      required: ['action', 'scope', 'id', 'top_type', 'days', 'limit'],
      additionalProperties: false,
    },
  },

  // ── kill_battles ──────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_battles',
    description:
      'Battle reports from EVE-KILL. List battles globally or for an entity, get detailed battle with killmails. ' +
      'Battles are auto-detected from killmail clusters.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'detail'],
          description: 'list=browse battles (optionally filtered by entity), detail=single battle with killmails.',
        },
        scope: {
          type: ['string', 'null'], enum: ['character', 'corporation', 'alliance', null],
          description: 'For list: filter by entity type. Null for global list.',
        },
        id: { type: ['integer', 'null'], description: 'For list: entity ID to filter. For detail: battle ID.' },
        limit: { type: ['integer', 'null'], description: 'For list: 1-100, default 10.' },
      },
      required: ['action', 'scope', 'id', 'limit'],
      additionalProperties: false,
    },
  },

  // ── kill_entity ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_entity',
    description:
      'Entity intelligence from EVE-KILL: character/corporation/alliance details, corp history, ' +
      'alliance history, member lists, alliance corporations, coalition detection. ' +
      'Use when user asks "who is this player/corp/alliance", "what corp was he in", "who are their allies".',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['entity_detail', 'corp_history', 'alliance_history', 'members', 'alliance_corps', 'coalition'],
          description: 'entity_detail=char/corp/alliance info, corp_history=character corp changes, ' +
            'alliance_history=corp alliance changes, members=corp/alliance member list, ' +
            'alliance_corps=corps in alliance, coalition=top 10 coalition partners (alliance, 90d).',
        },
        scope: {
          type: ['string', 'null'], enum: ['character', 'corporation', 'alliance', null],
          description: 'Entity type. Required for entity_detail and members.',
        },
        id: { type: 'integer', description: 'Entity ID.' },
        limit: { type: ['integer', 'null'], description: 'For members/alliance_corps: 1-100, default 100.' },
      },
      required: ['action', 'scope', 'id', 'limit'],
      additionalProperties: false,
    },
  },

  // ── kill_lookup ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_lookup',
    description:
      'Look up specific killmails, find related kills, search entities, or get war/faction details from EVE-KILL. ' +
      'Use when user has a killmail ID, wants sibling kills, or needs to find an entity by name.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['killmail', 'killmail_batch', 'killmail_sibling', 'search', 'war', 'war_killmails', 'faction'],
          description: 'killmail=single kill by ID, killmail_batch=multiple by IDs, killmail_sibling=related loss ±1hr, ' +
            'search=find entity by name, war=war details, war_killmails=kills in war, faction=faction details.',
        },
        id: { type: ['integer', 'null'], description: 'Killmail/war/faction ID. Required for all except search and killmail_batch.' },
        ids: {
          type: ['array', 'null'], items: { type: 'integer' },
          description: 'For killmail_batch: array of killmail IDs.',
        },
        search_term: { type: ['string', 'null'], description: 'For search: entity name to look up.' },
      },
      required: ['action', 'id', 'ids', 'search_term'],
      additionalProperties: false,
    },
  },

  // ── kill_spatial ──────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_spatial',
    description:
      'Spatial killmail search from EVE-KILL: find kills near a celestial object or 3D coordinates. ' +
      'Use when user asks "kills near this gate/station/planet" or needs proximity analysis.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['near_celestial', 'near_coordinates'],
          description: 'near_celestial=kills near a celestial (gate, station, planet), near_coordinates=kills near x/y/z in a system.',
        },
        celestial_id: { type: ['integer', 'null'], description: 'For near_celestial: celestial object ID.' },
        system_id: { type: ['integer', 'null'], description: 'For near_coordinates: solar system ID.' },
        x: { type: ['number', 'null'], description: 'For near_coordinates: X coordinate in meters.' },
        y: { type: ['number', 'null'], description: 'For near_coordinates: Y coordinate.' },
        z: { type: ['number', 'null'], description: 'For near_coordinates: Z coordinate.' },
        distance_meters: { type: ['integer', 'null'], description: 'Search radius in meters (default 100000).' },
        days: { type: ['integer', 'null'], description: 'Time window in days (default 7).' },
        limit: { type: ['integer', 'null'], description: 'For near_coordinates: max results (1-50, default 50).' },
      },
      required: ['action', 'celestial_id', 'system_id', 'x', 'y', 'z', 'distance_meters', 'days', 'limit'],
      additionalProperties: false,
    },
  },

  // ── kill_prices ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_prices',
    description:
      'Item prices and build costs from EVE-KILL. Market prices across regions or blueprint build cost calculation. ' +
      'Use when user asks "how much does it cost to build X" or needs price data from EVE-KILL.',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['build_price', 'type_prices'],
          description: 'build_price=calculate blueprint build cost from materials, type_prices=market prices across regions.',
        },
        type_id: { type: 'integer', description: 'Item type_id. Resolve via sde_sql first.' },
        days: { type: ['integer', 'null'], description: 'Price data window in days (default 7).' },
      },
      required: ['action', 'type_id', 'days'],
      additionalProperties: false,
    },
  },

  // ── kill_watch ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'kill_watch',
    description:
      'Subscribe to real-time kill notifications via WebSocket. Watch a specific player, system, or region — ' +
      'bot will send a Telegram alert when a matching kill happens. ' +
      'Use when user asks "follow player X", "watch system Uedama", "alert me about kills in Delve".',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['watch', 'unwatch', 'list'],
          description: 'watch=subscribe to kill alerts, unwatch=remove subscription, list=show active watches.',
        },
        topic_type: {
          type: ['string', 'null'],
          enum: ['victim', 'attacker', 'system', 'region', null],
          description: 'What to watch. victim=when player dies, attacker=when player kills, system/region=all kills in area.',
        },
        topic_id: {
          type: ['integer', 'null'],
          description: 'CCP ID: character_id, system_id, or region_id. Resolve via sde_sql or kill_lookup search.',
        },
        label: {
          type: ['string', 'null'],
          description: 'Human-readable label for the watch (e.g. player/system name).',
        },
      },
      required: ['action', 'topic_type', 'topic_id', 'label'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Namespace builder
// ---------------------------------------------------------------------------

export function buildEveKillNamespace(): NativeNamespaceTool {
  return {
    type: 'namespace',
    name: 'eve_kill',
    description:
      'PvP killboard data and intelligence from EVE-KILL. ' +
      'Use when user asks about: kills in a system, player/corp killboard, ship fits from losses, ' +
      'expensive kills, battle reports, who is dangerous, coalition partners, build costs, PvP rankings, ' +
      'OR when user wants real-time kill alerts/notifications ("follow player", "watch system", "alert me about kills").',
    tools: DEFERRED_EVE_KILL_TOOLS,
  };
}
