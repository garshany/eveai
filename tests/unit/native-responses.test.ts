import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete process.env.OPENAI_PROVIDER;
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
  process.env.OPENAI_RESPONSE_STATE_MODE = 'stateless';
  process.env.OPENAI_STORE_RESPONSES = 'false';
});

afterEach(() => {
  delete process.env.OPENAI_PROVIDER;
  process.env.OPENAI_RESPONSE_STATE_MODE = 'stateless';
  process.env.OPENAI_STORE_RESPONSES = 'false';
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
  it('normalizes JSON, NDJSON, and SSE payloads carried in one WebSocket message', async () => {
    const { __test__ } = await import('../../src/agent/native-responses.js');
    expect(__test__.parseWebSocketMessage('{"type":"response.created"}')).toHaveLength(1);
    expect(__test__.parseWebSocketMessage('[{"type":"response.created"},{"type":"codex.rate_limits"}]'))
      .toHaveLength(2);
    expect(__test__.parseWebSocketMessage('0')).toEqual([]);
    expect(__test__.consumeWebSocketBuffer('{')).toEqual({ frames: [], rest: '{' });
    const consumed = __test__.consumeWebSocketBuffer([
      '{"type":"response.created","note":"brace } in string"}',
      '{"type":"response.completed","response":{"status":"completed"}}',
      '{"type":"response.output_text.delta"',
    ].join(''));
    expect(consumed.frames.map((event) => event.event)).toEqual([
      'response.created',
      'response.completed',
    ]);
    expect(consumed.rest).toBe('{"type":"response.output_text.delta"');
    expect(__test__.parseWebSocketMessage([
      '{"type":"response.output_text.delta","delta":"ok"}',
      '{"type":"response.completed","response":{"status":"completed"}}',
    ].join('\n')).map((event) => event.event)).toEqual([
      'response.output_text.delta',
      'response.completed',
    ]);
    expect(__test__.parseWebSocketMessage([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      '',
    ].join('\n'))[0]?.event).toBe('response.completed');
    expect(() => __test__.parseWebSocketMessage('not-json')).toThrow();
  });

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

  it('extracts function calls from response.function_call_arguments.done events', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    const { __test__ } = await import('../../src/agent/native-responses.js');

    const raw = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"plan_route","arguments":""}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"origin\\":\\"Jita\\""}',
      '',
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","name":"plan_route","output_index":0,"arguments":"{\\"origin\\":\\"Jita\\",\\"destination\\":\\"Amarr\\"}","sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"response":{"id":"resp_fc","output":[]}}',
      '',
    ].join('\n');

    const events = __test__.parseSse(raw);
    expect(__test__.collectDoneItems(events)).toEqual([
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'plan_route',
        arguments: '{"origin":"Jita","destination":"Amarr"}',
      },
    ]);
  });

  it('reconstructs indexed program chains in provider order without stripping caller fields', async () => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    const { __test__ } = await import('../../src/agent/native-responses.js');
    const raw = [
      'event: response.output_item.done',
      'data: {"output_index":2,"item":{"type":"program_output","id":"po_1","call_id":"prog_call_1","result":"partial","status":"incomplete","provider_extension":{"x":1}}}',
      '',
      'event: response.output_item.done',
      'data: {"output_index":0,"item":{"type":"program","id":"prog_1","call_id":"prog_call_1","code":"opaque","fingerprint":"fp_1"}}',
      '',
      'event: response.output_item.done',
      'data: {"output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"count_1","name":"count_universe_objects","arguments":"{}","caller":{"type":"program","caller_id":"prog_call_1"}}}',
      '',
    ].join('\n');

    expect(__test__.collectDoneItems(__test__.parseSse(raw))).toEqual([
      { type: 'program', id: 'prog_1', call_id: 'prog_call_1', code: 'opaque', fingerprint: 'fp_1' },
      { type: 'function_call', id: 'fc_1', call_id: 'count_1', name: 'count_universe_objects', arguments: '{}', caller: { type: 'program', caller_id: 'prog_call_1' } },
      { type: 'program_output', id: 'po_1', call_id: 'prog_call_1', result: 'partial', status: 'incomplete', provider_extension: { x: 1 } },
    ]);
  });
});

describe('createNativeResponse request body', () => {
  it('never exposes a non-2xx provider body through the thrown error or logs', async () => {
    const sentinel = 'provider-private-payload-must-not-escape';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: `remote failure arguments=${sentinel}` },
    }), { status: 400 })));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    let thrown: unknown;
    try {
      await createNativeResponse({ instructions: 'test', items: [toNativeMessage('pulse')], tools: [] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Responses API HTTP 400');
    expect((thrown as Error).message).not.toContain(sentinel);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(sentinel);
    logSpy.mockRestore();
  });

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

  it('sends the GPT-5.6 Responses tuning parameters configured for Telegram', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    process.env.OPENAI_MODEL = 'gpt-5.6-sol';
    process.env.OPENAI_REASONING_EFFORT = 'auto';
    process.env.OPENAI_REASONING_MODE = 'standard';
    process.env.OPENAI_TEXT_VERBOSITY = 'low';
    process.env.OPENAI_STORE_RESPONSES = 'false';

    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_gpt56","output_text":"ok","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');

    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
    });

    expect(body?.model).toBe('gpt-5.6-sol');
    // `auto` is local routing policy; internal calls use the preserved medium baseline.
    expect(body?.reasoning).toEqual({ effort: 'medium' });
    expect(body?.text).toEqual({ verbosity: 'low' });
    expect(body?.store).toBe(false);
    expect(body?.stream).toBe(true);
  });

  it('opts the Responses request into stored logs when configured', async () => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    process.env.OPENAI_STORE_RESPONSES = 'true';

    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_stored","output_text":"ok","output":[]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
    });

    expect(body?.store).toBe(true);
    expect(body?.previous_response_id).toBeUndefined();
  });

  it('uses the fixed CheapVibeCode WebSocket endpoint and omits stream', async () => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    process.env.OPENAI_PROVIDER = 'cheapvibecode';

    const { __test__ } = await import('../../src/agent/native-responses.js');
    const requestBody = __test__.buildWebSocketCreatePayload({
      model: 'gpt-5.6-sol',
      input: [],
      tools: [],
      stream: true,
      background: false,
    });
    const requestHeaders = __test__.buildWebSocketHeaders('test', '00000000-0000-4000-8000-000000000000');

    expect(__test__.responsesWebSocketUrl('https://cheapvibecode.ru/backend-api/codex'))
      .toBe('wss://cheapvibecode.ru/backend-api/codex/responses');
    expect(requestBody).toMatchObject({ type: 'response.create', model: 'gpt-5.6-sol' });
    expect(requestBody).not.toHaveProperty('stream');
    expect(requestBody).not.toHaveProperty('background');
    expect(requestHeaders.authorization).toBe('Bearer test');
    expect(requestHeaders['OpenAI-Beta']).toBe('responses_websockets=2026-02-06');
    expect(requestHeaders['x-client-request-id']).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('keeps automatic truncation on the default OpenAI provider', async () => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';

    let requestBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_openai","output_text":"ok","output":[]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
      truncation: 'auto',
    });

    expect(requestBody?.truncation).toBe('auto');
  });

  it('requests encrypted reasoning only when same-turn stateless replay is enabled', async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_reasoning","output_text":"ok","output":[]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
      preserveReasoning: true,
    });
    expect(body?.include).toEqual(['reasoning.encrypted_content']);

    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
    });
    expect(body?.include).toEqual([]);
  });

  it('forwards every GPT-5.6 family model and supported fixed reasoning effort', async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_options","output_text":"ok","output":[]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    const models = ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

    for (const model of models) {
      for (const reasoningEffort of efforts) {
        await createNativeResponse({
          instructions: 'test',
          items: [toNativeMessage('hello')],
          tools: [],
          model,
          reasoningEffort,
        });
        expect(body?.model).toBe(model);
        expect(body?.reasoning).toEqual({ effort: reasoningEffort });
      }
    }
  });

  it('serializes Pro mode only when requested and forwards the safety identifier', async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_pro","output_text":"ok","output":[]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
      reasoningEffort: 'xhigh',
      reasoningMode: 'pro',
      safetyIdentifier: 'opaque-user-id',
    });
    expect(body?.reasoning).toEqual({ effort: 'xhigh', mode: 'pro' });
    expect(body?.safety_identifier).toBe('opaque-user-id');

    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
      reasoningEffort: 'low',
      reasoningMode: 'standard',
    });
    expect(body?.reasoning).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('safety_identifier');
  });

  it('parses GPT-5.6 cache-write usage separately from cache reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'event: response.done',
      'data: {"response":{"id":"resp_usage","output_text":"ok","output":[],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":40,"cache_write_tokens":60},"output_tokens_details":{"reasoning_tokens":5}}}}',
      '',
    ].join('\n'), { status: 200 })));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    const result = await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
    });
    expect(result.usage).toEqual({
      input: 100,
      output: 20,
      total: 120,
      cached: 40,
      cacheWrite: 60,
      reasoning: 5,
    });
  });

  it('requests a reasoning summary only for a streaming top-level call with a sink', async () => {
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
        'data: {"response":{"id":"r","output_text":"ok","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    const { runWithActivitySink } = await import('../../src/agent/activity.js');
    const sink = { emit: () => {} };
    const call = (streamToActivity: boolean) =>
      createNativeResponse({ instructions: 't', items: [toNativeMessage('hi')], tools: [], reasoningEffort: 'medium', streamToActivity });

    // Internal call (streamToActivity false) with a sink active: no summary, no leaked reasoning.
    await runWithActivitySink(sink, () => call(false));
    expect(body?.reasoning).toEqual({ effort: 'medium' });

    // Top-level streaming call with a sink: summary requested.
    await runWithActivitySink(sink, () => call(true));
    expect(body?.reasoning).toEqual({ effort: 'medium', summary: 'auto' });

    // No sink (the bots) even with streamToActivity true: unchanged request.
    await call(true);
    expect(body?.reasoning).toEqual({ effort: 'medium' });
  });

  it('forwards prompt_cache_key to the proxy', async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_y","output_text":"ok","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');

    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
      promptCacheKey: 'thread_abc123',
    });

    expect(body?.prompt_cache_key).toBe('thread_abc123');
  });

  it('omits prompt_cache_key when not provided', async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'event: response.done',
        'data: {"response":{"id":"resp_z","output_text":"ok","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
        '',
      ].join('\n'), { status: 200 });
    }));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');

    await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
    });

    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  it('converts response function calls into stateless continuation input items without dropping phase', async () => {
    const { buildFunctionCallInputItems } = await import('../../src/agent/native-responses.js');

    expect(buildFunctionCallInputItems([
      { type: 'reasoning', id: 'rs_1' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo_city', arguments: '{"name":"Jita"}', status: 'completed', phase: 'final' },
      { type: 'message', content: [{ type: 'output_text', text: 'ignored' }] },
    ])).toEqual([
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo_city', arguments: '{"name":"Jita"}', status: 'completed', phase: 'final' },
    ]);
  });

  it('replays opaque reasoning and calls in provider order for stateless continuation', async () => {
    const { buildOrderedContinuationInputItems } = await import('../../src/agent/native-responses.js');
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'opaque-ciphertext',
      summary: [],
    };
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'echo_city',
      arguments: '{"name":"Jita"}',
      status: 'completed',
      phase: 'final',
    };

    expect(buildOrderedContinuationInputItems([
      reasoning,
      call,
      { type: 'message', content: [{ type: 'output_text', text: 'ignored' }] },
    ])).toEqual([
      reasoning,
      call,
      { type: 'message', content: [{ type: 'output_text', text: 'ignored' }] },
    ]);
    expect(buildOrderedContinuationInputItems([reasoning, call], false)).toEqual([call]);
  });

  it('preserves program items and copies the validated caller to function outputs', async () => {
    const { buildOrderedContinuationInputItems, buildFunctionCallOutputs } = await import('../../src/agent/native-responses.js');
    const caller = { type: 'program' as const, caller_id: 'prog_call_1' };
    const items = [
      { type: 'program', id: 'prog_1', call_id: 'prog_call_1', code: 'opaque', fingerprint: 'fp_1' },
      { type: 'program_output', id: 'po_1', call_id: 'prog_call_1', result: 'partial', status: 'incomplete', provider_extension: { x: 1 } },
    ];
    expect(buildOrderedContinuationInputItems(items)).toEqual(items);
    expect(buildFunctionCallOutputs([{ callId: 'fc_1', output: '{"ok":true}', caller }])).toEqual([{
      type: 'function_call_output', call_id: 'fc_1', output: '{"ok":true}', caller,
    }]);
  });

  it('uses done items when response.completed.output is empty', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';

    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"echo_city","arguments":"{\\"city\\":\\"Jita\\"}"}}',
      '',
      'event: response.completed',
      'data: {"response":{"id":"resp_done_only","output":[]}}',
      '',
    ].join('\n'), { status: 200 })));

    const { createNativeResponse, toNativeMessage, extractFunctionCalls } = await import('../../src/agent/native-responses.js');

    const result = await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
    });

    expect(result.id).toBe('resp_done_only');
    expect(result.output.map((item) => item.type)).toEqual(['function_call']);
    expect(extractFunctionCalls(result.output)).toEqual([
      {
        callId: 'call_1',
        name: 'echo_city',
        argumentsText: '{"city":"Jita"}',
      },
    ]);
  });

  it('flags a truncated stream (no terminal event, no output) as an error', async () => {
    process.env.ALLOWED_TELEGRAM_USER_ID = '1';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.EVE_CLIENT_ID = 'test';
    process.env.EVE_CLIENT_SECRET = 'test';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';

    // Stream opens but is cut off before any terminal (response.completed/done)
    // event and before any output — must not look like a valid empty answer.
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_trunc"}}',
      '',
    ].join('\n'), { status: 200 })));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');

    const result = await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
    });

    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain('Incomplete response stream');
    expect(result.outputText).toBe('');
  });

  it('flags a truncated stream even when it contains a partial function call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_partial"}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_partial","name":"sde_sql","arguments":"{\\"sql\\":\\"SELECT 1\\"}"}}',
      '',
    ].join('\n'), { status: 200 })));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    const result = await createNativeResponse({
      instructions: 'test',
      items: [toNativeMessage('hello')],
      tools: [],
    });

    expect(result.output.some((item) => item.type === 'function_call')).toBe(true);
    expect(result.error?.message).toContain('Incomplete response stream');
  });

  it('does not write raw streamed error payloads to logs', async () => {
    const sentinel = 'remote-error-must-not-be-logged';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'event: response.failed',
      `data: {"error":{"message":"${sentinel}"}}`,
      '',
    ].join('\n'), { status: 200 })));

    const { createNativeResponse, toNativeMessage } = await import('../../src/agent/native-responses.js');
    const result = await createNativeResponse({ instructions: 'test', items: [toNativeMessage('pulse')], tools: [] });
    expect(result.error?.message).toBe('Responses API provider error');
    expect(result.error?.message).not.toContain(sentinel);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(sentinel);
    logSpy.mockRestore();
  });
});
