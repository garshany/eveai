import { describe, expect, it } from 'vitest';
import type { NativeTool } from '../../src/agent/native-responses.js';
import { prepareClientToolSearch, searchClientTools } from '../../src/agent/client-tool-search.js';

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
});
