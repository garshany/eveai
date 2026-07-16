import type {
  NativeFunctionTool,
  NativeNamespaceTool,
  NativeTool,
  NativeToolSearchOutputItem,
} from './native-responses.js';
import type { ToolRegistryLoadDelta } from './tool-registry.js';

const MAX_SEARCH_RESULTS = 8;
const MAX_SEARCH_QUERY_CHARS = 256;
const MAX_SEARCH_OUTPUT_CHARS = 48_000;
export const MAX_CLIENT_DISCOVERED_FUNCTIONS = 80;
export const MAX_CLIENT_DISCOVERED_NAMESPACES = 32;
export const MAX_CLIENT_DISCOVERED_SCHEMA_BYTES = 96_000;
const CLIENT_EAGER_FUNCTIONS = new Set([
  'web_search',
  'update_plan',
  'get_eve_capabilities',
  'plan_route',
  'count_universe_objects',
  'sde_sql',
  'local_parallel_batch',
  'delegate_read_subagents',
]);

type SearchEntry = {
  path: string;
  namespace: NativeNamespaceTool | null;
  tool: NativeFunctionTool;
  searchable: string;
};

export type ClientToolSearchIndex = ReadonlyArray<SearchEntry>;

export type ClientDiscoveryUsage = {
  functions: number;
  namespaces: number;
  bytes: number;
};

export function canApplyClientDiscoveryDelta(
  usage: ClientDiscoveryUsage,
  delta: Pick<ToolRegistryLoadDelta, 'functions' | 'namespaces' | 'bytes'>,
): boolean {
  return usage.functions + delta.functions <= MAX_CLIENT_DISCOVERED_FUNCTIONS
    && usage.namespaces + delta.namespaces <= MAX_CLIENT_DISCOVERED_NAMESPACES
    && usage.bytes + delta.bytes <= MAX_CLIENT_DISCOVERED_SCHEMA_BYTES;
}

export function prepareClientToolSearch(tools: NativeTool[]): {
  requestTools: NativeTool[];
  index: ClientToolSearchIndex;
} {
  const index: SearchEntry[] = [];
  const requestTools: NativeTool[] = [];

  for (const tool of tools) {
    if (tool.type === 'tool_search') continue;
    if (tool.type === 'function') {
      if (tool.defer_loading === true || !CLIENT_EAGER_FUNCTIONS.has(tool.name)) {
        index.push(searchEntry(null, tool));
      }
      else requestTools.push(tool);
      continue;
    }
    if (tool.type === 'namespace') {
      const immediate: NativeFunctionTool[] = [];
      for (const nested of tool.tools) {
        if (nested.defer_loading === true) index.push(searchEntry(tool, nested));
        else immediate.push(nested);
      }
      if (immediate.length > 0) requestTools.push({ ...tool, tools: immediate });
      continue;
    }
    requestTools.push(tool);
  }

  requestTools.unshift({
    type: 'tool_search',
    execution: 'client',
    description: 'Search locally for deferred EVE tools. Use one short English capability query containing every currently-ready need; request up to 8 results for multi-part work. This is capability discovery, not catalog browsing: after a search, execute every relevant returned tool (independent reads together) before searching again. Already loaded schemas are omitted.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_SEARCH_QUERY_CHARS },
        limit: {
          type: 'number',
          description: `Maximum number of tools to return. Defaults to 5 and is capped locally at ${MAX_SEARCH_RESULTS}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  });

  return { requestTools, index: Object.freeze(index) };
}

export function searchClientTools(
  index: ClientToolSearchIndex,
  callId: string,
  rawArguments: unknown,
  options: { excludeNames?: ReadonlySet<string> } = {},
): NativeToolSearchOutputItem {
  const parsed = validateClientToolSearchArguments(rawArguments);
  const tools = parsed
    ? search(index, parsed.query, parsed.limit, options.excludeNames ?? new Set())
    : [];
  return {
    type: 'tool_search_output',
    call_id: callId,
    status: 'completed',
    execution: 'client',
    tools,
  };
}

export function validateClientToolSearchArguments(
  value: unknown,
): { query: string; limit: number } | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'query' && key !== 'limit')) return null;
  if (typeof record.query !== 'string') return null;
  const query = record.query.trim();
  if (!query || query.length > MAX_SEARCH_QUERY_CHARS) return null;
  const limit = record.limit === undefined ? 5 : record.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return null;
  }
  return { query, limit: Math.min(limit, MAX_SEARCH_RESULTS) };
}

function search(
  index: ClientToolSearchIndex,
  query: string,
  limit: number,
  excludeNames: ReadonlySet<string>,
): NativeTool[] {
  const normalizedQuery = normalize(query);
  const queryTokens = new Set(tokenize(normalizedQuery));
  const matches = index
    .filter((entry) => !excludeNames.has(entry.tool.name))
    .map((entry) => ({ entry, score: score(entry, normalizedQuery, queryTokens) }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
    .slice(0, limit)
    .map((match) => match.entry);

  const output: NativeTool[] = [];
  const namespacePositions = new Map<string, number>();
  for (const match of matches) {
    if (!match.namespace) {
      output.push(match.tool);
      continue;
    }
    const position = namespacePositions.get(match.namespace.name);
    if (position === undefined) {
      namespacePositions.set(match.namespace.name, output.length);
      output.push({ ...match.namespace, tools: [match.tool] });
    } else {
      const namespace = output[position] as NativeNamespaceTool;
      namespace.tools.push(match.tool);
    }
  }
  while (output.length > 0 && JSON.stringify(output).length > MAX_SEARCH_OUTPUT_CHARS) output.pop();
  return output;
}

function searchEntry(namespace: NativeNamespaceTool | null, tool: NativeFunctionTool): SearchEntry {
  const path = namespace ? `${namespace.name}.${tool.name}` : tool.name;
  return Object.freeze({
    path,
    namespace,
    tool: Object.freeze({ ...tool }),
    searchable: normalize(`${path} ${namespace?.description ?? ''} ${tool.description}`),
  });
}

function score(entry: SearchEntry, query: string, queryTokens: Set<string>): number {
  const path = normalize(entry.path);
  if (path === query) return 10_000;
  let value = path.includes(query) ? 2_000 : 0;
  const searchTokens = new Set(tokenize(entry.searchable));
  for (const token of queryTokens) {
    if (searchTokens.has(token)) value += 100;
    else if ([...searchTokens].some((candidate) => candidate.startsWith(token))) value += 30;
  }
  return value;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim();
}

function tokenize(value: string): string[] {
  return value.split(/[\s_]+/).filter((token) => token.length >= 2);
}
