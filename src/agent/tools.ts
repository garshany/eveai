import { config } from '../config.js';
import { loadEsiCatalog, listEsiNamespaces } from '../eve/esi-catalog.js';
import { buildEveKillNamespace, isEveKillToolName } from '../eve-kill/tools.js';
import { buildEveScoutNamespace, isEveScoutToolName } from '../eve/eve-scout-tools.js';
import type { NativeFunctionTool, NativeTool } from './native-responses.js';
import { SDE_SCHEMA } from './tools/sde-schema.js';

const SDE_SQL_TOOL_NAME = 'sde_sql';
const WEB_SEARCH_TOOL_NAME = 'web_search';

export { SDE_SCHEMA };

const UNIVERSE_COUNT_TOOL_NAME = 'count_universe_objects';
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
    description: 'Inspect the currently available ESI namespaces, granted scopes, and accessible operations for the active Telegram user/chat. Call ONLY when you need private ESI access and the granted scopes are not already listed in the prompt context. Do NOT call if scopes are already shown above or if you only need public/SDE data.',
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
    description: 'Plan a route between two EVE systems. Returns up to 3 variants (secure/shortest/insecure) with jump count, security, recent kill stats, danger systems with detailed killmails, and formatted_summary ready for output. Includes built-in danger scan — do NOT call zKill or ESI killmails separately. Sets autopilot waypoints when requested. Accepts system names or IDs.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Origin system name or ID. Use "current" to use the current location from prompt context.' },
        destination: { type: 'string', description: 'Destination system name or ID' },
        set_autopilot: { type: ['boolean', 'null'], description: 'Set autopilot to the preferred route (default true)' },
        prefer: { type: ['string', 'null'], enum: ['secure', 'shortest', 'insecure', 'thera_shortcut', null], description: 'Which route to prefer for autopilot. thera_shortcut sets waypoints for WH shortcut: entry system → exit system → destination (default: secure)' },
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
    description: 'Query the local EVE Static Data Export (SDE) via SQL. Use this tool for: resolving item/ship/module names↔IDs, ship and module stats (dogma attributes: DPS, range, speed, tank, cap, fitting), ship role bonuses (sde_type_bonus), blueprint materials and manufacturing time, system/region/constellation lookups, security status, stargate destinations, meta group (Tech I/II/Faction/Officer), group/category classification. JOIN sde_type_dogma with sde_dogma_attributes to get human-readable attribute names. See <sde_schema> for tables, columns, JSON fields, and ready-to-use dogma query pattern. Batch multiple lookups: WHERE name IN (...) or WHERE type_id IN (...). Always prefer this over ESI for static data.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Read-only SQL query. Use json_extract() for data_json fields, json_each() for arrays. Max 50 rows returned.' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
];

const ROUTE_MONITOR_TOOL_NAME = 'route_monitor';

const ROUTE_MONITOR_TOOL: NativeFunctionTool = {
  type: 'function',
  name: ROUTE_MONITOR_TOOL_NAME,
  description: 'Control real-time route monitoring. Auto-starts when autopilot is set via plan_route. Use to check monitoring status or stop active monitoring.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'stop'],
        description: 'status = show current monitoring state, stop = disable monitoring.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export function isRouteMonitorTool(name: string): boolean {
  return name === ROUTE_MONITOR_TOOL_NAME;
}

const HEARTBEAT_CONFIG_TOOL_NAME = 'heartbeat_config';

const HEARTBEAT_CONFIG_TOOL: NativeFunctionTool = {
  type: 'function',
  name: HEARTBEAT_CONFIG_TOOL_NAME,
  description: 'Configure periodic background checks for the player (mail, skills, wallet, etc.). The heartbeat runs on a schedule and proactively notifies the user in Telegram when something new happens. Use when the user asks to set up notifications, periodic checks, or monitoring of their EVE character.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['enable', 'disable', 'set_interval', 'enable_check', 'disable_check', 'list'],
        description: 'enable/disable heartbeat, set_interval to change frequency, enable_check/disable_check to toggle specific checks, list to show current config.',
      },
      interval_seconds: {
        type: ['integer', 'null'],
        description: 'Interval in seconds for set_interval action. Min 300 (5min), max 604800 (7d). Common: 3600=1h, 86400=1d.',
      },
      check: {
        type: ['string', 'null'],
        enum: ['mail', 'skills', 'wallet', 'industry', 'contracts', 'killmails', 'orders', 'notifications', 'pi', null],
        description: 'Check type for enable_check/disable_check. mail=new messages, skills=queue empty/completed, wallet=balance changes >10M, industry=jobs completed, contracts=new incoming, killmails=kills/losses, orders=filled/expired, notifications=wars/structure alerts, pi=stale extractors.',
      },
    },
    required: ['action', 'interval_seconds', 'check'],
    additionalProperties: false,
  },
};

export function isHeartbeatConfigTool(name: string): boolean {
  return name === HEARTBEAT_CONFIG_TOOL_NAME;
}

const BATCH_MARKET_TOOL_NAME = 'batch_market_prices';
const OSINT_INFER_TOOL_NAME = 'osint_infer_home';
const ANALYZE_LOCAL_TOOL_NAME = 'analyze_local';
const ANALYZE_SCAN_TOOL_NAME = 'analyze_scan';
const INTEL_NOTE_TOOL_NAME = 'intel_note';

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

const OSINT_INFER_TOOL: NativeFunctionTool = {
  type: 'function',
  name: OSINT_INFER_TOOL_NAME,
  description: 'Infer likely home, staging, and hunting systems for a character, corporation, or alliance using precomputed activity-graph features from EVE-KILL plus local SDE geography. Returns probabilistic hypotheses with confidence, signals, uncertainty, and an optional compact graph digest. Prefer this over manual residence inference from raw kill feeds.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['character', 'corporation', 'alliance'],
        description: 'Target entity type to analyze.',
      },
      id: {
        type: 'integer',
        description: 'CCP ID of the character, corporation, or alliance.',
      },
      window_days: {
        type: ['integer', 'null'],
        description: 'Recent analysis window in days. Default 30, max 90.',
      },
      include_member_analysis: {
        type: ['boolean', 'null'],
        description: 'Include a compact core-member breakdown derived from recurring pilots in the observed activity.',
      },
      include_graph: {
        type: ['boolean', 'null'],
        description: 'Include a compact graph digest for downstream reasoning and explanations.',
      },
      include_llm_pattern_analysis: {
        type: ['boolean', 'null'],
        description: 'Run an optional LLM pass over the compact graph digest to classify higher-level patterns. Use only when the user explicitly wants deeper pattern analysis.',
      },
    },
    required: ['scope', 'id', 'window_days', 'include_member_analysis', 'include_graph', 'include_llm_pattern_analysis'],
    additionalProperties: false,
  },
};

const ANALYZE_LOCAL_TOOL: NativeFunctionTool = {
  type: 'function',
  name: ANALYZE_LOCAL_TOOL_NAME,
  description: 'Analyze a pasted EVE Online local chat member list. Resolves character names, fetches corporation/alliance affiliations, kill statistics, and top ships for active PvPers. Returns grouped intel with threat assessment. Copy character names from in-game local chat and paste them.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      pilots: {
        type: 'string',
        description: 'Newline-separated character names copied from EVE Online local chat window.',
      },
      days: {
        type: ['integer', 'null'],
        description: 'Kill stats lookback period in days. Default 7, max 90.',
      },
    },
    required: ['pilots', 'days'],
    additionalProperties: false,
  },
};

const ANALYZE_SCAN_TOOL: NativeFunctionTool = {
  type: 'function',
  name: ANALYZE_SCAN_TOOL_NAME,
  description: 'Analyze an EVE Online scan paste: D-Scan, Local chat, or Fleet composition. Auto-detects scan type from paste format. D-Scan → ship/structure/deployable breakdown by class with fleet profile, capitals extraction, and "interesting" items highlight. Local → pilot intel with kill stats (delegates to analyze_local). Fleet → ship composition with doctrine analysis. Paste raw text from EVE client.',
  strict: true,
  defer_loading: true,
  parameters: {
    type: 'object',
    properties: {
      paste: {
        type: 'string',
        description: 'Raw paste from EVE client: D-Scan (tab-separated with type IDs and distances), Local chat (character names per line), or Fleet composition (tab-separated with ship types and pilot names).',
      },
      scan_type: {
        type: ['string', 'null'],
        enum: ['dscan', 'local', 'fleet', null],
        description: 'Force scan type. null = auto-detect from paste format.',
      },
      days: {
        type: ['integer', 'null'],
        description: 'Kill stats lookback for local scan mode. Default 7, max 90. Ignored for dscan/fleet.',
      },
    },
    required: ['paste', 'scan_type', 'days'],
    additionalProperties: false,
  },
};

export function isAnalyzeScanTool(name: string): boolean {
  return name === ANALYZE_SCAN_TOOL_NAME;
}

const INTEL_NOTE_TOOL: NativeFunctionTool = {
  type: 'function',
  name: INTEL_NOTE_TOOL_NAME,
  description: 'Personal intel notebook — save, search, list, or delete notes about systems, regions, entities, or anything EVE-related. Notes persist across conversations. Use when the user says "запомни", "заметка", "запиши" or asks to recall previous intel.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'search', 'list', 'delete'],
        description: 'save = create note, search = find notes by filters, list = recent notes, delete = remove by note_id.',
      },
      text: {
        type: ['string', 'null'],
        description: 'Note content for save action. Max 2000 chars.',
      },
      system: {
        type: ['string', 'null'],
        description: 'EVE system name to attach or search by. Auto-resolved via SDE. Wormhole names stored as-is.',
      },
      region: {
        type: ['string', 'null'],
        description: 'EVE region name to attach or search by. Auto-set from system if not provided.',
      },
      entity_name: {
        type: ['string', 'null'],
        description: 'Player, corporation, or alliance name related to this note.',
      },
      tag: {
        type: ['string', 'null'],
        enum: ['general', 'hostile', 'friendly', 'structure', 'wormhole', 'route', 'market', 'bookmark', null],
        description: 'Note category tag. Default: general.',
      },
      query: {
        type: ['string', 'null'],
        description: 'Free-text search in note content (for search action).',
      },
      note_id: {
        type: ['integer', 'null'],
        description: 'Note ID for delete action.',
      },
    },
    required: ['action', 'text', 'system', 'region', 'entity_name', 'tag', 'query', 'note_id'],
    additionalProperties: false,
  },
};

export function isIntelNoteTool(name: string): boolean {
  return name === INTEL_NOTE_TOOL_NAME;
}

const SET_ACTIVE_FIT_TOOL_NAME = 'set_active_fit';

const SET_ACTIVE_FIT_TOOL: NativeFunctionTool = {
  type: 'function',
  name: SET_ACTIVE_FIT_TOOL_NAME,
  description: 'Set or replace the active fitting in the user profile (USER.md). Use when the user pastes an EFT fit or says "мой фит теперь этот". The fitting is persisted and used for all future tactical assessments.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      fitting: {
        type: 'string',
        description: 'EFT-format fitting text or free-form module list. Will be stored as-is in USER.md.',
      },
    },
    required: ['fitting'],
    additionalProperties: false,
  },
};

export function isSetActiveFitTool(name: string): boolean {
  return name === SET_ACTIVE_FIT_TOOL_NAME;
}

export async function buildNativeAgentTools(mode: 'full' | 'static_aggregate' = 'full'): Promise<NativeTool[]> {
  if (mode === 'static_aggregate') {
    return ALWAYS_ON_FUNCTION_TOOLS.filter((tool) =>
      tool.name === UNIVERSE_COUNT_TOOL_NAME
      || tool.name === SDE_SQL_TOOL_NAME,
    );
  }

  // Only offer web_search when a Tavily key is configured. Without it the tool
  // is weak (EVE-Uni wiki only) and the model wastes turns on it instead of
  // answering game-data questions from the local SDE / live ESI.
  const alwaysOn = config.tavily?.apiKey
    ? ALWAYS_ON_FUNCTION_TOOLS
    : ALWAYS_ON_FUNCTION_TOOLS.filter((tool) => tool.name !== WEB_SEARCH_TOOL_NAME);

  return [
    { type: 'tool_search' },
    ...alwaysOn,
    ROUTE_MONITOR_TOOL,
    HEARTBEAT_CONFIG_TOOL,
    BATCH_MARKET_TOOL,
    OSINT_INFER_TOOL,
    ANALYZE_LOCAL_TOOL,
    ANALYZE_SCAN_TOOL,
    INTEL_NOTE_TOOL,
    SET_ACTIVE_FIT_TOOL,
    buildEveKillNamespace(),
    buildEveScoutNamespace(),
    ...(await listEsiNamespaces()),
  ];
}

export function getAlwaysOnFunctionToolNames(): string[] {
  return ALWAYS_ON_FUNCTION_TOOLS.map((tool) => tool.name);
}

export function isBatchMarketTool(name: string): boolean {
  return name === BATCH_MARKET_TOOL_NAME;
}

export function isOsintInferTool(name: string): boolean {
  return name === OSINT_INFER_TOOL_NAME;
}

export function isAnalyzeLocalTool(name: string): boolean {
  return name === ANALYZE_LOCAL_TOOL_NAME;
}

export function isUniverseCountTool(name: string): boolean {
  return name === UNIVERSE_COUNT_TOOL_NAME;
}

export function isSdeSqlTool(name: string): boolean {
  return name === SDE_SQL_TOOL_NAME;
}

export function isDeferredLookupToolName(name: string): boolean {
  return isEveKillToolName(name) || isEveScoutToolName(name) || isBatchMarketTool(name) || isOsintInferTool(name) || isAnalyzeLocalTool(name) || isAnalyzeScanTool(name) || isIntelNoteTool(name) || isSetActiveFitTool(name);
}

export { isEveKillToolName } from '../eve-kill/tools.js';
export { isEveScoutToolName } from '../eve/eve-scout-tools.js';

export { executeSdeSql, executeUniverseObjectCount } from './tools/sde-execution.js';
export type { UniverseCountResult } from './tools/sde-execution.js';

export { planRoute } from '../eve/route-planner.js';
export type { PlanRouteArgs } from '../eve/route-planner.js';

export async function getToolPolicy(name: string): Promise<'read' | 'write' | 'ui' | null> {
  // Tools that mutate local state must be 'write' so the executor runs them
  // sequentially, never in the parallel read path (avoids lost-update races on
  // USER.md, intel_notes, heartbeat_config, and route monitors).
  if (
    name === 'update_plan'
    || isIntelNoteTool(name)
    || isSetActiveFitTool(name)
    || isHeartbeatConfigTool(name)
    || isRouteMonitorTool(name)
  ) {
    return 'write';
  }
  if (getAlwaysOnFunctionToolNames().includes(name) || isEveKillToolName(name) || isEveScoutToolName(name) || isBatchMarketTool(name) || isOsintInferTool(name) || isAnalyzeScanTool(name) || isAnalyzeLocalTool(name)) {
    return 'read';
  }
  const catalog = await loadEsiCatalog();
  return catalog.get(name)?.toolPolicy ?? null;
}
