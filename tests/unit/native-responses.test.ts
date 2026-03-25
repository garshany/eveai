import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toNativeMessage', () => {
  it('serializes messages as user input_text', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    const { toNativeMessage } = await import('../../src/agent/native-responses.js');

    expect(toNativeMessage('hello')).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    });
  });
});

describe('extractToolSearchPaths', () => {
  it('collects namespace names and nested tool names from tool_search_output', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    const { extractToolSearchPaths } = await import('../../src/agent/native-responses.js');

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

describe('parseSse + streamed outputs', () => {
  it('parses SSE stream, extracts deltas, done items, and terminal payload', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    const { __test__ } = await import('../../src/agent/native-responses.js');

    const raw = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hi "}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"there"}',
      '',
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","text":"Hi there"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"tool_search_output","paths":["get_markets_region_id_orders"]}}',
      '',
      'event: response.done',
      'data: {"response":{"id":"resp_x","output_text":"Hi there","output":[{"type":"message","content":[{"type":"output_text","text":"Hi there"}]}]}}',
      '',
    ].join('\n');

    const events = __test__.parseSse(raw);
    expect(__test__.extractStreamedOutputText(events)).toBe('Hi there');
    expect(__test__.collectDoneItems(events)).toEqual([
      { type: 'tool_search_output', paths: ['get_markets_region_id_orders'] },
    ]);
    expect(__test__.findCompletedPayload(events)?.id).toBe('resp_x');
  });

  it('uses data.type when event is omitted and handles CRLF', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    const { __test__ } = await import('../../src/agent/native-responses.js');

    const raw = [
      'data: {"type":"response.output_text.delta","delta":"Yo"}',
      '',
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","text":"Yo"}',
      '',
    ].join('\r\n');

    const events = __test__.parseSse(raw);
    expect(events[0]?.event).toBe('response.output_text.delta');
    expect(__test__.extractStreamedOutputText(events)).toBe('Yo');
  });
});

describe('createNativeResponse request body', () => {
  it('forwards previous_response_id and context_management to the proxy', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';

    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_x","output_text":"ok","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');

    const result = await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
      previousResponseId: 'resp_prev',
      contextManagement: [{ type: 'compaction', compact_threshold: 1234 }],
    });

    expect(result.id).toBe('resp_x');
    expect(body?.previous_response_id).toBe('resp_prev');
    expect(body?.context_management).toEqual([{ type: 'compaction', compact_threshold: 1234 }]);
  });
});
