import { describe, expect, it } from 'vitest';
import { extractToolSearchPaths, toNativeMessage } from '../../src/agent/native-responses.js';

describe('toNativeMessage', () => {
  it('serializes messages as user input_text', () => {
    expect(toNativeMessage('hello')).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    });
  });
});

describe('extractToolSearchPaths', () => {
  it('collects namespace names and nested tool names from tool_search_output', () => {
    expect(extractToolSearchPaths([
      {
        type: 'tool_search_output',
        tools: [
          {
            type: 'namespace',
            name: 'eve_character_wallet',
            tools: [
              { type: 'function', name: 'get_characters_character_id_wallet' },
            ],
          },
        ],
      },
    ])).toEqual([
      'eve_character_wallet',
      'get_characters_character_id_wallet',
    ]);
  });
});
