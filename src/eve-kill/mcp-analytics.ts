import { config } from '../config.js';
import { fetchRetrying } from '../eve/http.js';
import { isCanonicalIsoTimestamp } from './normalize.js';
import type { EveKillAnalyticsToolName } from './analytics-tools.js';

export const EVE_KILL_MCP_URL = 'https://mcp.eve-kill.com/mcp';

const JSON_RPC_ID = 1;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;

type JsonRpcEnvelope = {
  jsonrpc: '2.0';
  id: number;
  method: 'tools/call';
  params: {
    name: EveKillAnalyticsToolName;
    arguments: Record<string, unknown>;
  };
};

export async function executeEveKillAnalyticsTool(
  name: EveKillAnalyticsToolName,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let validated: Record<string, unknown>;
  try {
    validated = validateAnalyticsArgs(name, args);
  } catch {
    return analyticsFailure(name, 'Invalid EVE-KILL analytics arguments');
  }

  try {
    const envelope: JsonRpcEnvelope = {
      jsonrpc: '2.0',
      id: JSON_RPC_ID,
      method: 'tools/call',
      params: { name, arguments: validated },
    };
    const response = await fetchRetrying(
      EVE_KILL_MCP_URL,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'User-Agent': config.eveKill.userAgent,
        },
        body: JSON.stringify(envelope),
      },
      {
        maxAttempts: config.eveKill.retryMaxAttempts,
        backoffMaxMs: config.eveKill.backoffMaxMs,
        timeoutMs: config.eveKill.timeoutMs,
      },
    );
    if (!response.ok) return analyticsFailure(name, `EVE-KILL analytics HTTP ${response.status}`, response.status);
    const raw = await readTextCapped(response);
    const payload = parseToolCallResponse(extractJsonRpcResponse(
      raw,
      response.headers.get('content-type'),
    ));
    return {
      ok: true,
      source: 'EVE-KILL MCP',
      transport: 'local_public_wrapper',
      tool: name,
      authoritative: false,
      limitation: 'Third-party public analytics; coverage and derived classifications may be incomplete.',
      data: payload,
    };
  } catch {
    return analyticsFailure(name, 'EVE-KILL analytics request failed');
  }
}

function validateAnalyticsArgs(
  name: EveKillAnalyticsToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (name) {
    case 'doctrine_detect': {
      assertOnlyKeys(args, ['entity', 'type', 'since', 'until', 'min_cluster_size', 'include_rookie_ships', 'limit']);
      const entity = positiveInt(args.entity, 'entity');
      const type = requiredEnum(args.type, ['character', 'corporation', 'alliance'] as const, 'type');
      const window = timeWindow(args.since, args.until);
      return compact({
        entity,
        type,
        ...window,
        min_cluster_size: optionalBoundedInt(args.min_cluster_size, 2, 10_000, 'min_cluster_size'),
        include_rookie_ships: optionalBoolean(args.include_rookie_ships, 'include_rookie_ships'),
        limit: optionalBoundedInt(args.limit, 1, 30, 'limit'),
      });
    }
    case 'meta_pulse': {
      assertOnlyKeys(args, ['region_id', 'ship_category', 'since', 'until', 'min_cluster_size', 'include_rookie_ships', 'limit']);
      const window = timeWindow(args.since, args.until);
      return compact({
        region_id: optionalPositiveInt(args.region_id, 'region_id'),
        ship_category: optionalEnum(
          args.ship_category,
          ['all', 'frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship', 'capital', 'supercap', 'subcap'] as const,
          'ship_category',
        ),
        ...window,
        min_cluster_size: optionalBoundedInt(args.min_cluster_size, 1, 10_000, 'min_cluster_size'),
        include_rookie_ships: optionalBoolean(args.include_rookie_ships, 'include_rookie_ships'),
        limit: optionalBoundedInt(args.limit, 1, 30, 'limit'),
      });
    }
    case 'killmail_forensics':
      assertOnlyKeys(args, ['killmail_id']);
      return { killmail_id: positiveInt(args.killmail_id, 'killmail_id') };
    case 'coalition_graph': {
      assertOnlyKeys(args, ['since', 'until', 'min_edge_weight', 'min_alliance_battles', 'focus_alliance', 'limit_edges']);
      const window = timeWindow(args.since, args.until);
      return compact({
        ...window,
        min_edge_weight: optionalBoundedInt(args.min_edge_weight, 1, 10_000, 'min_edge_weight'),
        min_alliance_battles: optionalBoundedInt(args.min_alliance_battles, 1, 10_000, 'min_alliance_battles'),
        focus_alliance: optionalPositiveInt(args.focus_alliance, 'focus_alliance'),
        limit_edges: optionalBoundedInt(args.limit_edges, 1, 500, 'limit_edges'),
      });
    }
  }
}

function timeWindow(sinceValue: unknown, untilValue: unknown): { since?: string; until?: string } {
  const since = optionalTimestamp(sinceValue, 'since');
  const until = optionalTimestamp(untilValue, 'until');
  if ((since === undefined) !== (until === undefined)) {
    throw new Error('since and until must be provided together');
  }
  if (!since || !until) return {};
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (sinceMs >= untilMs) throw new Error('since must be earlier than until');
  if (untilMs - sinceMs > MAX_WINDOW_MS) throw new Error('analytics window cannot exceed 366 days');
  return { since, until };
}

function optionalTimestamp(value: unknown, name: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || !isCanonicalIsoTimestamp(value)) {
    throw new Error(`${name} must be a canonical ISO-8601 timestamp with an explicit timezone`);
  }
  return value;
}

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  return value === null || value === undefined ? undefined : positiveInt(value, name);
}

function optionalBoundedInt(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
): T[number] | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value as T[number];
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
): T[number] {
  const result = optionalEnum(value, allowed, name);
  if (result === undefined) throw new Error(`${name} is required`);
  return result;
}

function assertOnlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(args).find((key) => !allowedSet.has(key));
  if (extra) throw new Error(`unexpected analytics argument: ${extra}`);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function readTextCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response too large');
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error('response exceeded size cap');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('response exceeded size cap');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

function parseToolCallResponse(raw: string): unknown {
  const envelope = record(JSON.parse(raw), 'JSON-RPC response');
  if (envelope.jsonrpc !== '2.0' || envelope.id !== JSON_RPC_ID) {
    throw new Error('invalid JSON-RPC envelope');
  }
  if (envelope.error !== undefined && envelope.error !== null) {
    throw new Error('JSON-RPC error');
  }
  if (envelope.result === undefined || envelope.result === null) throw new Error('missing JSON-RPC result');
  const result = record(envelope.result, 'JSON-RPC result');
  if (result.isError === true) throw new Error('tool returned an error');
  const structured = result.structuredContent;
  const hasStructured = structured !== undefined && structured !== null;
  let contentValue: unknown;
  if (result.content !== undefined) {
    if (!Array.isArray(result.content) || result.content.length !== 1) {
      throw new Error('tool result content must contain exactly one block');
    }
    const first = record(result.content[0], 'tool result content');
    if (first.type !== 'text' || typeof first.text !== 'string') {
      throw new Error('tool result must contain JSON text');
    }
    contentValue = JSON.parse(first.text) as unknown;
    assertJsonComplexity(contentValue);
  }
  if (hasStructured) assertJsonComplexity(structured);
  if (!hasStructured && contentValue === undefined) {
    throw new Error('tool result contains no data');
  }
  if (hasStructured && contentValue !== undefined && !jsonValuesEqual(structured, contentValue)) {
    throw new Error('conflicting tool result representations');
  }
  return hasStructured ? structured : contentValue;
}

function extractJsonRpcResponse(raw: string, contentType: string | null): string {
  if (!contentType?.toLowerCase().includes('text/event-stream')) return raw;

  let dataLines: string[] = [];
  for (const line of `${raw}\n`.split(/\r?\n/)) {
    if (line === '') {
      if (dataLines.length > 0) {
        const data = dataLines.join('\n');
        dataLines = [];
        if (data === '[DONE]') continue;
        try {
          const candidate = JSON.parse(data) as unknown;
          if (
            candidate
            && typeof candidate === 'object'
            && !Array.isArray(candidate)
            && (candidate as Record<string, unknown>).jsonrpc === '2.0'
            && (candidate as Record<string, unknown>).id === JSON_RPC_ID
            && (
              Object.hasOwn(candidate, 'result')
              || Object.hasOwn(candidate, 'error')
            )
          ) {
            return data;
          }
        } catch {
          // Ignore non-response events; fail with a fixed local error if no
          // matching JSON-RPC response event is present.
        }
      }
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  throw new Error('SSE stream contained no matching JSON-RPC response');
}

function assertJsonComplexity(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error('tool result exceeded JSON node limit');
    if (current.depth > MAX_JSON_DEPTH) throw new Error('tool result exceeded JSON depth limit');
    if (Array.isArray(current.value)) {
      if (nodes + stack.length + current.value.length > MAX_JSON_NODES) {
        throw new Error('tool result exceeded JSON node limit');
      }
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === 'object') {
      const objectValue = current.value as Record<string, unknown>;
      for (const key in objectValue) {
        if (!Object.hasOwn(objectValue, key)) continue;
        if (nodes + stack.length + 1 > MAX_JSON_NODES) {
          throw new Error('tool result exceeded JSON node limit');
        }
        stack.push({
          value: objectValue[key],
          depth: current.depth + 1,
        });
      }
    }
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function analyticsFailure(
  name: EveKillAnalyticsToolName,
  error: string,
  status?: number,
): Record<string, unknown> {
  return {
    ok: false,
    source: 'EVE-KILL MCP',
    transport: 'local_public_wrapper',
    tool: name,
    error,
    ...(status === undefined ? {} : { status }),
  };
}

export const __test__ = {
  validateAnalyticsArgs,
  parseToolCallResponse,
  extractJsonRpcResponse,
  assertJsonComplexity,
  MAX_RESPONSE_BYTES,
  MAX_JSON_DEPTH,
};
