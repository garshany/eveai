import { describe, expect, it } from 'vitest';

describe('agent tools', () => {
  it('preloads deferred tool catalogs as hosted namespaces', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    const { buildNativeAgentTools } = await import('../../src/agent/tools.js');

    const tools = await buildNativeAgentTools();
    const functionNames = tools
      .filter((tool): tool is Extract<(typeof tools)[number], { type: 'function' }> => tool.type === 'function')
      .map((tool) => tool.name);
    const namespaces = tools.filter((tool): tool is Extract<(typeof tools)[number], { type: 'namespace' }> => tool.type === 'namespace');
    const namespaceNames = namespaces.map((tool) => tool.name);

    expect(functionNames).toContain('web_search');
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
    expect(namespaceNames).toContain('eve_scout');
    expect(namespaceNames).toContain('eve_character_assets');
    expect(namespaceNames).toContain('eve_public_market_orders');
    expect(namespaceNames).toContain('eve_authenticated_market_structures');
    expect(namespaceNames).toContain('eve_character_search');
    expect(namespaceNames).toContain('eve_public_affiliation_lookup');
    expect(namespaceNames).toContain('eve_character_fittings');
    expect(namespaceNames).not.toContain('eve_character_fittings_bookmarks');
    expect(namespaces.every((tool) => tool.tools.length <= 9)).toBe(true);
    expect(
      namespaces.some((tool) =>
        tool.name === 'eve_kill'
        && tool.tools.some((entry) => entry.name === 'kill_feed'),
      ),
    ).toBe(true);

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
    expect(functionNames).not.toContain('web_search');
    expect(functionNames).not.toContain('update_plan');
    expect(functionNames).not.toContain('get_eve_capabilities');
    expect(functionNames).not.toContain('plan_route');
    expect(functionNames).not.toContain('batch_market_prices');
    expect(functionNames).not.toContain('osint_infer_home');
    expect(tools.some((tool) => tool.type === 'tool_search')).toBe(false);
    expect(tools.some((tool) => tool.type === 'namespace')).toBe(false);
  });
});
