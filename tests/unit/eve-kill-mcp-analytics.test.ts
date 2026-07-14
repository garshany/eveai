import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVE_KILL_MCP_URL,
  __test__,
  executeEveKillAnalyticsTool,
} from '../../src/eve-kill/mcp-analytics.js';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(toolResponse({ result: 'ok' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('EVE-KILL MCP analytics transport', () => {
  it.each([
    ['doctrine_detect', { entity: 99, type: 'alliance', since: null, until: null, min_cluster_size: null, include_rookie_ships: null, limit: 3 }],
    ['meta_pulse', { region_id: null, ship_category: 'capital', since: null, until: null, min_cluster_size: null, include_rookie_ships: false, limit: 4 }],
    ['killmail_forensics', { killmail_id: 123 }],
    ['coalition_graph', { since: null, until: null, min_edge_weight: null, min_alliance_battles: null, focus_alliance: 88, limit_edges: 25 }],
  ] as const)('calls %s through the fixed public JSON-RPC endpoint', async (name, args) => {
    const result = await executeEveKillAnalyticsTool(name, args);

    expect(result).toMatchObject({
      ok: true,
      source: 'EVE-KILL MCP',
      transport: 'local_public_wrapper',
      tool: name,
      authoritative: false,
      data: { result: 'ok' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EVE_KILL_MCP_URL);
    expect(url).toBe('https://mcp.eve-kill.com/mcp');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null)),
      },
    });
  });

  it('rejects extra/private fields and names before network egress without echoing values', async () => {
    const secret = 'private-token-sentinel';
    const extra = await executeEveKillAnalyticsTool('killmail_forensics', {
      killmail_id: 123,
      private_token: secret,
    });
    const nameInsteadOfId = await executeEveKillAnalyticsTool('doctrine_detect', {
      entity: 'Some Character',
      type: 'character',
      since: null,
      until: null,
      min_cluster_size: null,
      include_rookie_ships: null,
      limit: null,
    });

    expect(extra).toMatchObject({ ok: false, error: 'Invalid EVE-KILL analytics arguments' });
    expect(nameInsteadOfId).toMatchObject({ ok: false, error: 'Invalid EVE-KILL analytics arguments' });
    expect(JSON.stringify([extra, nameInsteadOfId])).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces strict identifiers, enums, bounds, and canonical paired windows', () => {
    expect(() => __test__.validateAnalyticsArgs('doctrine_detect', {
      entity: 7,
      type: null,
      since: null,
      until: null,
      min_cluster_size: null,
      include_rookie_ships: null,
      limit: null,
    })).toThrow('type is required');
    expect(() => __test__.validateAnalyticsArgs('meta_pulse', {
      region_id: 1,
      ship_category: 'titans',
      since: null,
      until: null,
      min_cluster_size: null,
      include_rookie_ships: null,
      limit: null,
    })).toThrow('invalid ship_category');
    expect(() => __test__.validateAnalyticsArgs('coalition_graph', {
      since: null,
      until: null,
      min_edge_weight: null,
      min_alliance_battles: null,
      focus_alliance: null,
      limit_edges: 501,
    })).toThrow('limit_edges must be an integer from 1 to 500');
    expect(() => __test__.validateAnalyticsArgs('coalition_graph', {
      since: '2026-01-01',
      until: '2026-01-02T00:00:00Z',
      min_edge_weight: null,
      min_alliance_battles: null,
      focus_alliance: null,
      limit_edges: null,
    })).toThrow('since must be a canonical ISO-8601 timestamp');
    expect(() => __test__.validateAnalyticsArgs('coalition_graph', {
      since: '2026-01-01T00:00:00Z',
      until: null,
      min_edge_weight: null,
      min_alliance_battles: null,
      focus_alliance: null,
      limit_edges: null,
    })).toThrow('since and until must be provided together');
    expect(() => __test__.validateAnalyticsArgs('coalition_graph', {
      since: '2026-01-02T00:00:00Z',
      until: '2026-01-01T00:00:00Z',
      min_edge_weight: null,
      min_alliance_battles: null,
      focus_alliance: null,
      limit_edges: null,
    })).toThrow('since must be earlier than until');

    const since = '2025-01-01T00:00:00.000Z';
    const exactLimit = new Date(Date.parse(since) + 366 * 24 * 60 * 60 * 1_000).toISOString();
    const overLimit = new Date(Date.parse(exactLimit) + 1).toISOString();
    expect(__test__.validateAnalyticsArgs('coalition_graph', {
      since,
      until: exactLimit,
      min_edge_weight: null,
      min_alliance_battles: null,
      focus_alliance: null,
      limit_edges: null,
    })).toMatchObject({ since, until: exactLimit });
    expect(() => __test__.validateAnalyticsArgs('coalition_graph', {
      since,
      until: overLimit,
      min_edge_weight: null,
      min_alliance_battles: null,
      focus_alliance: null,
      limit_edges: null,
    })).toThrow('analytics window cannot exceed 366 days');
  });

  it('parses a bounded MCP Streamable HTTP SSE response', async () => {
    const envelope = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"pulse":"ok"}' }] },
    });
    fetchMock.mockResolvedValueOnce(new Response(
      `event: message\ndata: ${envelope}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    ));

    const result = await executeEveKillAnalyticsTool('meta_pulse', {
      region_id: null,
      ship_category: null,
      since: null,
      until: null,
      min_cluster_size: null,
      include_rookie_ships: null,
      limit: 1,
    });
    expect(result).toMatchObject({ ok: true, data: { pulse: 'ok' } });
  });

  it('ignores an SSE server request that reuses the response id', () => {
    const serverRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sampling/createMessage',
      params: {},
    });
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
    });
    const extracted = __test__.extractJsonRpcResponse(
      `event: message\ndata: ${serverRequest}\n\nevent: message\ndata: ${response}\n\n`,
      'text/event-stream',
    );
    expect(__test__.parseToolCallResponse(extracted)).toEqual({ ok: true });
  });

  it('accepts structuredContent but rejects mismatched, malformed, and error envelopes safely', async () => {
    expect(__test__.parseToolCallResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { structuredContent: { b: 2, a: 1 } },
    }))).toEqual({ b: 2, a: 1 });
    expect(() => __test__.parseToolCallResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        structuredContent: { value: 1 },
        content: [{ type: 'text', text: '{"value":2}' }],
      },
    }))).toThrow('conflicting');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, error: { message: 'secret upstream detail' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await executeEveKillAnalyticsTool('killmail_forensics', { killmail_id: 123 });
    expect(result).toMatchObject({ ok: false, error: 'EVE-KILL analytics request failed' });
    expect(JSON.stringify(result)).not.toContain('secret upstream detail');
  });

  it('rejects declared oversized responses without reading or exposing the body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('hidden-body', {
      status: 200,
      headers: { 'content-length': String(__test__.MAX_RESPONSE_BYTES + 1) },
    }));
    const result = await executeEveKillAnalyticsTool('killmail_forensics', { killmail_id: 123 });
    expect(result).toMatchObject({ ok: false, error: 'EVE-KILL analytics request failed' });
    expect(JSON.stringify(result)).not.toContain('hidden-body');
  });

  it('rejects chunked oversized, malformed, and excessively deep payloads safely', async () => {
    const chunk = new Uint8Array(__test__.MAX_RESPONSE_BYTES / 2 + 1);
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 }));
    const oversized = await executeEveKillAnalyticsTool('killmail_forensics', { killmail_id: 123 });
    expect(oversized).toMatchObject({ ok: false, error: 'EVE-KILL analytics request failed' });

    fetchMock.mockResolvedValueOnce(new Response('{not-json', { status: 200 }));
    const malformed = await executeEveKillAnalyticsTool('killmail_forensics', { killmail_id: 123 });
    expect(malformed).toMatchObject({ ok: false, error: 'EVE-KILL analytics request failed' });

    const deep = `${'['.repeat(__test__.MAX_JSON_DEPTH + 2)}0${']'.repeat(__test__.MAX_JSON_DEPTH + 2)}`;
    expect(() => __test__.parseToolCallResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: deep }] },
    }))).toThrow('JSON depth limit');

    expect(() => __test__.assertJsonComplexity(
      Array.from({ length: 50_001 }, () => 0),
    )).toThrow('JSON node limit');
  });
});

function toolResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
