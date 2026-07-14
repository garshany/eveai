import { describe, expect, it, vi } from 'vitest';

describe('agent tools', () => {
  it('preloads deferred tool catalogs as hosted namespaces', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    // web_search is gated on TAVILY_API_KEY; clear it (and reset the cached config)
    // so this "no web_search" assertion is hermetic on a dev/CI box that has a key.
    delete process.env.TAVILY_API_KEY;
    vi.resetModules();
    const { buildNativeAgentTools, getToolPolicy } = await import('../../src/agent/tools.js');

    const tools = await buildNativeAgentTools();
    const functionNames = tools
      .filter((tool): tool is Extract<(typeof tools)[number], { type: 'function' }> => tool.type === 'function')
      .map((tool) => tool.name);
    const namespaces = tools.filter((tool): tool is Extract<(typeof tools)[number], { type: 'namespace' }> => tool.type === 'namespace');
    const namespaceNames = namespaces.map((tool) => tool.name);
    // Full turns include chat history, profile and private ESI context. A direct
    // hosted MCP descriptor would let the provider send model-generated
    // arguments to a third party before application code could inspect them.
    expect(tools.some((tool) => tool.type === 'mcp')).toBe(false);

    // web_search is gated on TAVILY_API_KEY, which is unset in this test env, so
    // it must be absent — offering a tool that always errors wastes agent turns.
    expect(functionNames).not.toContain('web_search');
    expect(functionNames).toContain('osint_infer_home');
    expect(functionNames).toContain('update_plan');
    expect(functionNames).toContain('get_eve_capabilities');
    expect(functionNames).toContain('plan_route');
    expect(functionNames).not.toContain('count_moons');
    expect(functionNames).toContain('count_universe_objects');
    expect(functionNames).toContain('sde_sql');
    expect(functionNames).toContain('batch_market_prices');
    // get_markets_region_id_orders is now in ESI namespace (eve_public_market_orders), not top-level
    expect(functionNames).not.toContain('get_markets_region_id_orders');
    expect(functionNames).not.toContain('sde_lookup_types');
    expect(functionNames).not.toContain('zkill_system_recent_kills');
    expect(functionNames).not.toContain('get_characters_character_id_assets');
    expect(functionNames).not.toContain('get_universe_systems_system_id');
    expect(namespaceNames).toContain('eve_kill');
    expect(namespaceNames).toContain('eve_kill_analytics');
    expect(namespaceNames).toContain('eve_scout');
    expect(namespaceNames).toContain('eve_character_assets');
    expect(namespaceNames).toContain('eve_public_market_orders');
    expect(namespaceNames).toContain('eve_authenticated_market_structures');
    expect(namespaceNames).toContain('eve_character_search');
    expect(namespaceNames).toContain('eve_public_affiliation_lookup');
    expect(namespaceNames).toContain('eve_character_fittings');
    expect(namespaceNames).not.toContain('eve_character_fittings_bookmarks');
    expect(namespaces.every((tool) => tool.tools.length <= 9)).toBe(true);
    const eveKillNamespace = namespaces.find((tool) => tool.name === 'eve_kill');
    expect(eveKillNamespace).toBeDefined();
    expect(eveKillNamespace?.tools.map((entry) => entry.name)).toEqual([
      'kill_search',
      'kill_activity',
      'kill_detail',
      'kill_intel',
      'kill_battles',
      'kill_watch',
    ]);
    expect(eveKillNamespace?.tools.some((entry) => entry.name === 'kill_feed')).toBe(false);
    expect(eveKillNamespace?.description).toContain('Third-party public kill discovery');
    expect(eveKillNamespace?.description).toContain('Use official ESI');
    expect(eveKillNamespace?.description).toContain('use local SDE');
    expect(await getToolPolicy('kill_watch')).toBe('write');
    expect(await getToolPolicy('kill_search')).toBe('read');
    expect(await getToolPolicy('doctrine_detect')).toBe('read');
    const analyticsNamespace = namespaces.find((tool) => tool.name === 'eve_kill_analytics');
    expect(analyticsNamespace?.tools.map((entry) => entry.name)).toEqual([
      'doctrine_detect',
      'meta_pulse',
      'killmail_forensics',
      'coalition_graph',
    ]);

    const transientTools = await buildNativeAgentTools('full', {
      notificationCapability: 'none',
    });
    const transientFunctions = transientTools
      .filter((tool): tool is Extract<(typeof transientTools)[number], { type: 'function' }> => tool.type === 'function')
      .map((tool) => tool.name);
    const transientEveKill = transientTools.find(
      (tool): tool is Extract<(typeof transientTools)[number], { type: 'namespace' }> =>
        tool.type === 'namespace' && tool.name === 'eve_kill',
    );
    expect(transientFunctions).not.toContain('route_monitor');
    expect(transientFunctions).not.toContain('heartbeat_config');
    expect(transientEveKill?.tools.map((tool) => tool.name)).not.toContain('kill_watch');

    const cliTools = await buildNativeAgentTools('full', {
      notificationCapability: 'feed',
    });
    const cliFunctions = cliTools
      .filter((tool): tool is Extract<(typeof cliTools)[number], { type: 'function' }> => tool.type === 'function')
      .map((tool) => tool.name);
    const cliEveKill = cliTools.find(
      (tool): tool is Extract<(typeof cliTools)[number], { type: 'namespace' }> =>
        tool.type === 'namespace' && tool.name === 'eve_kill',
    );
    expect(cliFunctions).toContain('route_monitor');
    expect(cliFunctions).not.toContain('heartbeat_config');
    expect(cliEveKill?.tools.map((tool) => tool.name)).toContain('kill_watch');

    const eveScoutNamespace = namespaces.find((tool) => tool.name === 'eve_scout');
    expect(eveScoutNamespace).toBeDefined();
    expect(eveScoutNamespace?.description).toContain('wormhole');
    expect(eveScoutNamespace?.tools.some((tool) => tool.name === 'scout_route')).toBe(true);
    expect(eveScoutNamespace?.tools.some((tool) => tool.name === 'scout_signatures')).toBe(true);
    expect(eveScoutNamespace?.tools.some((tool) => tool.name === 'scout_observations')).toBe(true);
    expect(eveScoutNamespace?.tools.some((tool) => tool.name === 'scout_wormhole_types')).toBe(true);
    expect(eveScoutNamespace?.tools.some((tool) => tool.name === 'scout_systems')).toBe(true);
    expect(eveScoutNamespace?.tools.every((tool) => tool.defer_loading === true)).toBe(true);

    // get_markets_region_id_orders lives inside eve_public_market_orders namespace
    const marketNamespace = namespaces.find((tool) => tool.name === 'eve_public_market_orders');
    expect(marketNamespace).toBeDefined();
    expect(marketNamespace?.description).toContain('market orders');
    const marketOrdersTool = marketNamespace?.tools.find((tool) => tool.name === 'get_markets_region_id_orders');
    expect(marketOrdersTool).toBeDefined();
    expect(marketOrdersTool?.defer_loading).toBe(true);
    const structureMarketNamespace = namespaces.find((tool) => tool.name === 'eve_authenticated_market_structures');
    expect(structureMarketNamespace).toBeDefined();
    expect(structureMarketNamespace?.description).toContain('structure');
    const structureMarketTool = structureMarketNamespace?.tools.find((tool) => tool.name === 'get_markets_structures_structure_id');
    expect(structureMarketTool).toBeDefined();
    expect(structureMarketTool?.defer_loading).toBe(true);

    const affiliationLookupNamespace = namespaces.find((tool) => tool.name === 'eve_public_affiliation_lookup');
    expect(affiliationLookupNamespace).toBeDefined();
    expect(affiliationLookupNamespace?.description).toContain('corporation');
    expect(affiliationLookupNamespace?.tools.some((tool) => tool.name === 'post_characters_affiliation')).toBe(true);
    expect(affiliationLookupNamespace?.tools.some((tool) => tool.name === 'get_characters_character_id_search')).toBe(false);

    const characterSearchNamespace = namespaces.find((tool) => tool.name === 'eve_character_search');
    expect(characterSearchNamespace).toBeDefined();
    expect(characterSearchNamespace?.tools.some((tool) => tool.name === 'get_characters_character_id_search')).toBe(true);

    const capabilitiesTool = tools.find((tool): tool is Extract<(typeof tools)[number], { type: 'function'; name: 'get_eve_capabilities' }> =>
      tool.type === 'function' && tool.name === 'get_eve_capabilities');
    expect(capabilitiesTool).toBeDefined();
    expect(capabilitiesTool?.defer_loading).toBe(true);
    expect(capabilitiesTool?.parameters).toEqual({
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'Short description of what you are trying to do with ESI.',
        },
      },
      required: ['intent'],
      additionalProperties: false,
    });

    const assetsNamespace = namespaces.find((tool) => tool.name === 'eve_character_assets');
    const assetsTool = assetsNamespace?.tools.find((tool) => tool.name === 'get_characters_character_id_assets');
    expect(assetsTool).toBeDefined();
    expect(assetsTool?.description).toContain('Response fields: is_blueprint_copy, is_singleton, item_id, location_flag, location_id, location_type, quantity, type_id.');
    expect((assetsTool?.parameters as { properties: Record<string, unknown> }).properties.fields).toEqual({
      type: ['array', 'null'],
      items: {
        type: 'string',
        enum: ['is_blueprint_copy', 'is_singleton', 'item_id', 'location_flag', 'location_id', 'location_type', 'quantity', 'type_id'],
      },
      description: 'Optional top-level response fields to return. Allowed fields: is_blueprint_copy, is_singleton, item_id, location_flag, location_id, location_type, quantity, type_id. Null uses the operation default behavior.',
    });
  });

  it('includes web_search only when TAVILY_API_KEY is configured', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    // config is frozen at first import, so reset the module registry to force a
    // fresh read of the env var we set below.
    vi.resetModules();
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    try {
      const { buildNativeAgentTools } = await import('../../src/agent/tools.js');
      const tools = await buildNativeAgentTools();
      const functionNames = tools
        .filter((tool): tool is Extract<(typeof tools)[number], { type: 'function' }> => tool.type === 'function')
        .map((tool) => tool.name);
      expect(functionNames).toContain('web_search');
    } finally {
      delete process.env.TAVILY_API_KEY;
      vi.resetModules();
    }
  });

  it('can build a reduced static-aggregate toolset without namespaces', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    const { buildNativeAgentTools } = await import('../../src/agent/tools.js');

    const tools = await buildNativeAgentTools('static_aggregate');
    const functionNames = tools
      .filter((tool): tool is Extract<(typeof tools)[number], { type: 'function' }> => tool.type === 'function')
      .map((tool) => tool.name);

    expect(functionNames).not.toContain('count_moons');
    expect(functionNames).toContain('count_universe_objects');
    expect(functionNames).toContain('sde_sql');
    const aggregateSql = tools.find((tool) => tool.type === 'function' && tool.name === 'sde_sql');
    expect(aggregateSql?.description).toContain('geography names and IDs');
    expect(aggregateSql?.description).not.toContain('dogma');
    expect(aggregateSql?.description).not.toContain('blueprint');
    expect(functionNames).not.toContain('web_search');
    expect(functionNames).not.toContain('update_plan');
    expect(functionNames).not.toContain('get_eve_capabilities');
    expect(functionNames).not.toContain('plan_route');
    expect(functionNames).not.toContain('batch_market_prices');
    expect(functionNames).not.toContain('osint_infer_home');
    expect(tools.some((tool) => tool.type === 'tool_search')).toBe(false);
    expect(tools.some((tool) => tool.type === 'namespace')).toBe(false);
    expect(tools.some((tool) => tool.type === 'mcp')).toBe(false);
  });
});
