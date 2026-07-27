/**
 * Agent tool declarations for the community API integrations. Execution lives
 * in the executor next to every other tool; this module only owns the schemas
 * and the name guards.
 */

import type { NativeFunctionTool } from '../agent/native-responses.js';

export const INDUSTRY_COST_TOOL_NAME = 'industry_cost';
export const APPRAISE_ITEMS_TOOL_NAME = 'appraise_items';
export const PILOT_INTEL_TOOL_NAME = 'pilot_intel';
export const ABYSSAL_MARKET_TOOL_NAME = 'abyssal_market';

export const INDUSTRY_COST_TOOL: NativeFunctionTool = {
  type: 'function',
  name: INDUSTRY_COST_TOOL_NAME,
  description: 'Manufacturing cost breakdown for building an item: required materials with quantities and unit costs, build time, totals. Data from the EVE Ref industry API. Use for "what does it cost to build X", "build or buy", and industry profitability questions. Resolve the product type_id via sde_sql first.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      product_id: { type: 'integer', minimum: 1, description: 'type_id of the item to manufacture (from sde_types).' },
      runs: { type: 'integer', minimum: 1, maximum: 10000, description: 'Number of production runs.' },
      me_level: { type: ['integer', 'null'], description: 'Blueprint material efficiency 0-10. Null for unmodified.' },
      te_level: { type: ['integer', 'null'], description: 'Blueprint time efficiency 0-20. Null for unmodified.' },
    },
    required: ['product_id', 'runs', 'me_level', 'te_level'],
    additionalProperties: false,
  },
};

export const APPRAISE_ITEMS_TOOL: NativeFunctionTool = {
  type: 'function',
  name: APPRAISE_ITEMS_TOOL_NAME,
  description: 'Appraise a pasted list of items (cargo scan, loot, inventory copy): resolves names, prices each line against the local market book (best sell/buy in the chosen region) and returns per-item and total ISK values. Accepts "Name<TAB>Qty", "Name x3" and bare-name lines. Use whenever the user pastes a list of items and wants its worth.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      items_text: { type: 'string', description: 'The pasted item list, one item per line, up to 200 lines.' },
      region_id: { type: ['integer', 'null'], description: 'Region to price against. Null = 10000002 (The Forge / Jita).' },
    },
    required: ['items_text', 'region_id'],
    additionalProperties: false,
  },
};

export const PILOT_INTEL_TOOL: NativeFunctionTool = {
  type: 'function',
  name: PILOT_INTEL_TOOL_NAME,
  description: 'Combat profile of a character, corporation or alliance from zKillboard aggregate stats: danger and gang ratios, ships destroyed/lost, ISK efficiency, favourite ships, most active UTC hours. Use for "who is this pilot", "how dangerous are they", threat assessment. Resolve the entity id first (ESI search or EVE-KILL). Complements kill_activity_summary (which reads raw killmail windows).',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['character', 'corporation', 'alliance'], description: 'Entity kind.' },
      id: { type: 'integer', minimum: 1, description: 'CCP id of the entity.' },
    },
    required: ['scope', 'id'],
    additionalProperties: false,
  },
};

export const ABYSSAL_MARKET_TOOL: NativeFunctionTool = {
  type: 'function',
  name: ABYSSAL_MARKET_TOOL_NAME,
  description: 'Current MutaMarket listings for an abyssal (mutated) module base type: asking prices and mutated attribute rolls. Mutated modules are unique items absent from the regular market — this is the only price source for them. Pass the ABYSSAL type_id (e.g. 47820 Large Abyssal Armor Plates), resolved via sde_sql.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      type_id: { type: 'integer', minimum: 1, description: 'Abyssal base type_id from sde_types.' },
    },
    required: ['type_id'],
    additionalProperties: false,
  },
};

export const COMMUNITY_TOOLS: NativeFunctionTool[] = [
  INDUSTRY_COST_TOOL,
  APPRAISE_ITEMS_TOOL,
  PILOT_INTEL_TOOL,
  ABYSSAL_MARKET_TOOL,
];

export function isCommunityToolName(name: string): boolean {
  return name === INDUSTRY_COST_TOOL_NAME
    || name === APPRAISE_ITEMS_TOOL_NAME
    || name === PILOT_INTEL_TOOL_NAME
    || name === ABYSSAL_MARKET_TOOL_NAME;
}
