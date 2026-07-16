import { describe, expect, it } from 'vitest';
import type { NativeTool } from '../../src/agent/native-responses.js';
import {
  canApplyClientDiscoveryDelta,
  MAX_CLIENT_DISCOVERED_FUNCTIONS,
  MAX_CLIENT_DISCOVERED_NAMESPACES,
  MAX_CLIENT_DISCOVERED_SCHEMA_BYTES,
  prepareClientToolSearch,
  searchClientTools,
} from '../../src/agent/client-tool-search.js';

const tools: NativeTool[] = [
  { type: 'tool_search' },
  {
    type: 'function',
    name: 'sde_sql',
    description: 'Always available local SDE lookup',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'market_history_summary',
    description: 'Summarize regional market price history',
    defer_loading: true,
    parameters: { type: 'object', properties: { type_id: { type: 'integer' } } },
  },
  {
    type: 'namespace',
    name: 'eve_character_wallet',
    description: 'Character wallet balances and transactions',
    tools: [{
      type: 'function',
      name: 'get_characters_character_id_wallet_transactions',
      description: 'Read wallet transactions for the linked character',
      defer_loading: true,
      parameters: { type: 'object', properties: { character_id: { type: 'integer' } } },
    }],
  },
];

describe('client tool search', () => {
  it('keeps deferred schemas local and returns deterministic trusted specs', () => {
    const prepared = prepareClientToolSearch(tools);
    expect(prepared.requestTools.some((tool) =>
      tool.type === 'function' && tool.name === 'market_history_summary')).toBe(false);
    expect(prepared.requestTools.some((tool) => tool.type === 'namespace')).toBe(false);
    expect(prepared.requestTools[0]).toMatchObject({ type: 'tool_search', execution: 'client' });
    expect(prepared.requestTools[0]).not.toHaveProperty('strict');

    const output = searchClientTools(prepared.index, 'call_search', {
      query: 'wallet transactions',
      limit: 2,
    });
    expect(output).toMatchObject({
      type: 'tool_search_output',
      call_id: 'call_search',
      execution: 'client',
      status: 'completed',
    });
    expect(output.tools).toEqual([expect.objectContaining({
      type: 'namespace',
      name: 'eve_character_wallet',
      tools: [expect.objectContaining({ name: 'get_characters_character_id_wallet_transactions' })],
    })]);
  });

  it('fails closed for malformed arguments', () => {
    const prepared = prepareClientToolSearch(tools);
    expect(searchClientTools(prepared.index, 'call_bad', {
      query: 'wallet',
      limit: 101,
    }).tools).toEqual([]);
    expect(searchClientTools(prepared.index, 'call_bad_json', '{bad json').tools).toEqual([]);
  });

  it('omits already exposed schemas from overlapping searches', () => {
    const prepared = prepareClientToolSearch(tools);
    const first = searchClientTools(prepared.index, 'first', {
      query: 'market history summary',
      limit: 2,
    });
    const exposed = new Set(first.tools.flatMap((tool) =>
      tool.type === 'function' ? [tool.name] : tool.type === 'namespace'
        ? tool.tools.map((nested) => nested.name)
        : []));
    const repeated = searchClientTools(
      prepared.index,
      'repeated',
      { query: 'market history summary', limit: 2 },
      { excludeNames: exposed },
    );

    expect(JSON.stringify(first.tools)).toContain('market_history_summary');
    expect(JSON.stringify(repeated.tools)).not.toContain('market_history_summary');
  });

  it('enforces function, namespace, and serialized-byte discovery ceilings', () => {
    const atBoundary = {
      functions: MAX_CLIENT_DISCOVERED_FUNCTIONS - 1,
      namespaces: MAX_CLIENT_DISCOVERED_NAMESPACES - 1,
      bytes: MAX_CLIENT_DISCOVERED_SCHEMA_BYTES - 10,
    };
    expect(canApplyClientDiscoveryDelta(atBoundary, {
      functions: 1,
      namespaces: 1,
      bytes: 10,
    })).toBe(true);
    expect(canApplyClientDiscoveryDelta(atBoundary, {
      functions: 2,
      namespaces: 1,
      bytes: 10,
    })).toBe(false);
    expect(canApplyClientDiscoveryDelta(atBoundary, {
      functions: 1,
      namespaces: 2,
      bytes: 10,
    })).toBe(false);
    expect(canApplyClientDiscoveryDelta(atBoundary, {
      functions: 1,
      namespaces: 1,
      bytes: 11,
    })).toBe(false);
  });
});
