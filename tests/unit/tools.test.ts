import { describe, expect, it } from 'vitest';
import { buildNativeAgentTools } from '../../src/agent/tools.js';

describe('agent tools', () => {
  it('preloads deferred tool catalogs as hosted namespaces', async () => {
    const tools = await buildNativeAgentTools();
    const functionNames = tools
      .filter((tool): tool is Extract<(typeof tools)[number], { type: 'function' }> => tool.type === 'function')
      .map((tool) => tool.name);
    const namespaces = tools.filter((tool): tool is Extract<(typeof tools)[number], { type: 'namespace' }> => tool.type === 'namespace');
    const namespaceNames = namespaces.map((tool) => tool.name);

    expect(functionNames).toContain('get_eve_capabilities');
    expect(functionNames).not.toContain('sde_lookup_types');
    expect(functionNames).not.toContain('zkill_system_recent_kills');
    expect(functionNames).not.toContain('get_characters_character_id_assets');
    expect(functionNames).not.toContain('get_universe_systems_system_id');
    expect(namespaceNames).toContain('eve_sde');
    expect(namespaceNames).toContain('eve_zkill');
    expect(namespaceNames).toContain('eve_character_assets');
    expect(namespaceNames).toContain('eve_universe_geography');
    expect(namespaces.every((tool) => tool.tools.length <= 9)).toBe(true);
    expect(
      namespaces.some((tool) =>
        tool.name === 'eve_sde'
        && tool.tools.some((entry) => entry.name === 'sde_lookup_types'),
      ),
    ).toBe(true);
    expect(
      namespaces.some((tool) =>
        tool.name === 'eve_zkill'
        && tool.tools.some((entry) => entry.name === 'zkill_system_recent_kills'),
      ),
    ).toBe(true);
    expect(
      namespaces.some((tool) =>
        tool.name === 'eve_character_assets'
        && tool.tools.some((entry) => entry.name === 'get_characters_character_id_assets'),
      ),
    ).toBe(true);
  });
});
