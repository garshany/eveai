import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NativeFunctionTool, NativeTool } from '../../src/agent/native-responses.js';

/**
 * Guard for the whole model-callable tool surface. Every tool that any mode
 * can declare must (a) reach a real handler, (b) carry a schema OpenAI strict
 * mode accepts, (c) have a unique name, and (d) be classified by the policy
 * that picks its admission and parallelism. A new tool that misses any of
 * these fails here instead of in a live turn.
 */

vi.hoisted(() => {
  // The checked-in swagger subset, never a stale operator cache.
  process.env.ESI_CATALOG_CACHE_PATH = './tests/fixtures/esi-swagger.json';
  process.env.TAVILY_API_KEY = 'tvly-surface-test';
  // Offline upstreams must fail fast, not back off for seconds per call.
  process.env.ESI_RETRY_MAX_ATTEMPTS = '1';
  process.env.ESI_BACKOFF_MAX_SECONDS = '1';
  process.env.EVE_KILL_RETRY_MAX_ATTEMPTS = '1';
  process.env.EVE_KILL_BACKOFF_MAX_MS = '100';
  process.env.COMMUNITY_API_RETRY_MAX_ATTEMPTS = '1';
  process.env.COMMUNITY_API_BACKOFF_MAX_MS = '100';
  process.env.EVE_SCOUT_RETRY_MAX_ATTEMPTS = '1';
  process.env.EVE_SCOUT_BACKOFF_MAX_MS = '100';
});

type Provider = { provider: 'openai' | 'modelhub'; programmatic: 'true' | 'false' };
const PROVIDERS: Provider[] = [
  { provider: 'openai', programmatic: 'false' },
  { provider: 'openai', programmatic: 'true' },
  { provider: 'modelhub', programmatic: 'false' },
];
const MODES = [
  ['full', 'all'], ['full', 'feed'], ['full', 'web'], ['full', 'none'],
  ['static_aggregate', 'all'], ['perimeter', 'all'],
] as const;

/** Tools deliberately declared without strict mode. Adding one is a decision. */
const NON_STRICT_ALLOWLIST = new Set(['kill_watch']);

type Surface = {
  label: string;
  topLevel: NativeTool[];
  functions: Array<{ tool: NativeFunctionTool; namespace: string | null }>;
};

const surfaces: Surface[] = [];
const policies = new Map<string, Array<'read' | 'write' | 'ui' | null>>();

async function loadProvider(provider: Provider) {
  vi.resetModules();
  process.env.OPENAI_PROVIDER = provider.provider;
  process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = provider.programmatic;
  return await import('../../src/agent/tools.js');
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('offline');
  }));
  for (const provider of PROVIDERS) {
    const tools = await loadProvider(provider);
    for (const [mode, notificationCapability] of MODES) {
      const topLevel = await tools.buildNativeAgentTools(mode, { notificationCapability });
      const functions = topLevel.flatMap((tool) => {
        if (tool.type === 'function') return [{ tool, namespace: null }];
        if (tool.type === 'namespace') return tool.tools.map((nested) => ({ tool: nested, namespace: tool.name }));
        return [];
      });
      surfaces.push({ label: `${provider.provider}/ptc=${provider.programmatic}/${mode}/${notificationCapability}`, topLevel, functions });
      for (const { tool } of functions) {
        const policy = await tools.getToolPolicy(tool.name, {});
        policies.set(tool.name, [...(policies.get(tool.name) ?? []), policy]);
      }
    }
  }
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
  process.env.OPENAI_PROVIDER = 'openai';
  process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'false';
});

// ---------------------------------------------------------------------------
// (b) OpenAI strict-mode schema rules
// ---------------------------------------------------------------------------

function typesOf(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.type) ? schema.type as string[] : typeof schema.type === 'string' ? [schema.type] : [];
}

function strictSchemaErrors(schema: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${path} is not a schema object`);
    return;
  }
  const node = schema as Record<string, unknown>;
  const types = typesOf(node);
  if (types.length === 0 && !node.anyOf && !node.enum && node.const === undefined) {
    errors.push(`${path} has no type`);
  }
  if (types.includes('object')) {
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(node.required) ? node.required as string[] : [];
    if (node.additionalProperties !== false) errors.push(`${path} must set additionalProperties:false`);
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) errors.push(`${path}.${key} is not listed in required`);
      strictSchemaErrors(properties[key], `${path}.${key}`, errors);
    }
    for (const key of required) {
      if (!(key in properties)) errors.push(`${path} requires undeclared ${key}`);
    }
  }
  if (types.includes('array')) {
    if (!node.items) errors.push(`${path} array has no items`);
    else strictSchemaErrors(node.items, `${path}[]`, errors);
  }
  if (Array.isArray(node.enum)) {
    for (const value of node.enum) {
      const kind = value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
      const allowed = types.length === 0 || types.includes(kind) || (kind === 'integer' && types.includes('number'));
      if (!allowed) errors.push(`${path} enum value ${JSON.stringify(value)} does not match type ${types.join('|')}`);
    }
    if (types.includes('null') && !node.enum.includes(null)) errors.push(`${path} is nullable but its enum lacks null`);
  }
  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((branch, index) => strictSchemaErrors(branch, `${path}.anyOf[${index}]`, errors));
  }
}

describe('agent tool surface', () => {
  it('declares a non-trivial surface in every mode', () => {
    expect(surfaces).toHaveLength(PROVIDERS.length * MODES.length);
    for (const surface of surfaces) {
      expect(surface.functions.length, surface.label).toBeGreaterThan(0);
    }
    const full = surfaces.find((surface) => surface.label === 'modelhub/ptc=false/full/all')!;
    const names = new Set(full.functions.map(({ tool }) => tool.name));
    for (const expected of ['local_parallel_batch', 'delegate_read_subagents', 'web_search', 'kill_watch', 'heartbeat_config', 'route_monitor', 'map_bubble_intel', 'get_status']) {
      expect(names.has(expected), expected).toBe(true);
    }
  });

  it('(b) gives every declared tool a schema OpenAI strict mode accepts', async () => {
    const { validateToolSchemaDefinition } = await import('../../src/agent/tool-registry.js');
    const failures: string[] = [];
    for (const surface of surfaces) {
      for (const { tool } of surface.functions) {
        const errors: string[] = [];
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) errors.push('invalid tool name');
        if (!tool.description?.trim()) errors.push('missing description');
        if (tool.parameters.type !== 'object') errors.push('root schema must be an object');
        const unsupported = validateToolSchemaDefinition(tool.parameters);
        if (unsupported) errors.push(unsupported);
        if (tool.strict === true) strictSchemaErrors(tool.parameters, '$', errors);
        else if (!NON_STRICT_ALLOWLIST.has(tool.name)) errors.push('not strict and not on the non-strict allowlist');
        if (tool.output_schema) {
          const outputError = validateToolSchemaDefinition(tool.output_schema);
          if (outputError) errors.push(`output_schema: ${outputError}`);
        }
        if (errors.length > 0) failures.push(`${surface.label} ${tool.name}: ${errors.join('; ')}`);
      }
    }
    expect([...new Set(failures)]).toEqual([]);
  });

  it('(c) keeps tool and namespace names unique across the top level and namespaces', () => {
    for (const surface of surfaces) {
      const names = surface.functions.map(({ tool }) => tool.name);
      const namespaces = surface.topLevel.flatMap((tool) => tool.type === 'namespace' ? [tool.name] : []);
      const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
      expect(duplicates, surface.label).toEqual([]);
      expect(new Set(namespaces).size, surface.label).toBe(namespaces.length);
      expect(namespaces.filter((name) => names.includes(name)), surface.label).toEqual([]);
    }
  });

  it('(d) classifies every declared tool with a policy', () => {
    const unclassified = [...policies.entries()]
      .filter(([, values]) => values.some((value) => value === null))
      .map(([name]) => name);
    expect(unclassified).toEqual([]);
    // Local mutations and UI actions must never land on the parallel read path.
    for (const name of ['update_plan', 'intel_note', 'set_active_fit', 'heartbeat_config', 'route_monitor', 'kill_watch']) {
      expect(policies.get(name)?.[0], name).toBe('write');
    }
    for (const name of ['post_ui_autopilot_waypoint', 'post_ui_openwindow_information', 'post_ui_openwindow_marketdetails']) {
      expect(policies.get(name)?.[0], name).toBe('ui');
    }
    // Lookup POSTs change nothing; they belong on the read path.
    for (const name of ['post_universe_names', 'post_universe_ids', 'post_characters_affiliation']) {
      expect(policies.get(name)?.[0], name).toBe('read');
    }
  });
});

// ---------------------------------------------------------------------------
// (a) Every declared tool reaches a handler
// ---------------------------------------------------------------------------

const PATTERN_SAMPLES = ['C140', 'task_1', 'x', 'Jita'];

function minimalValue(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.anyOf)) return minimalValue(schema.anyOf[0] as Record<string, unknown>);
  const types = typesOf(schema);
  if (types.includes('null')) return null;
  if (Array.isArray(schema.enum)) return schema.enum.find((value) => value !== null);
  if (schema.const !== undefined) return schema.const;
  const type = types[0];
  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, minimalValue(child)]));
    }
    case 'array': {
      const count = typeof schema.minItems === 'number' ? schema.minItems : 0;
      const item = minimalValue(schema.items as Record<string, unknown>);
      return Array.from({ length: count }, (_, index) => (typeof item === 'number' ? item + index : item));
    }
    case 'integer':
    case 'number': {
      const minimum = typeof schema.minimum === 'number' ? schema.minimum : 1;
      return Math.max(minimum, typeof schema.maximum === 'number' ? Math.min(1, schema.maximum) : 1);
    }
    case 'boolean':
      return false;
    case 'string': {
      if (schema.format === 'date-time') return new Date().toISOString();
      const minLength = typeof schema.minLength === 'number' ? schema.minLength : 1;
      if (typeof schema.pattern === 'string') {
        const pattern = new RegExp(schema.pattern);
        const sample = PATTERN_SAMPLES.find((candidate) => pattern.test(candidate) && candidate.length >= minLength);
        if (sample) return sample;
      }
      return 'x'.repeat(Math.max(1, minLength));
    }
    default:
      return null;
  }
}

describe('agent tool dispatch', () => {
  it('(a) routes schema-valid minimal arguments for every declared tool to a real handler', async () => {
    const tools = await loadProvider({ provider: 'modelhub', programmatic: 'false' });
    const { SCHEMA_SQL } = await import('../../src/db/schema.js');
    const { runMigrations } = await import('../../src/db/migrations.js');
    const { EffectiveToolRegistry, validateEffectiveToolCalls } = await import('../../src/agent/tool-registry.js');
    const { __test__ } = await import('../../src/agent/executor.js');
    const { createWebSearchState } = await import('../../src/agent/web-search.js');

    const union = new Map<string, NativeFunctionTool>();
    for (const surface of surfaces) {
      for (const { tool } of surface.functions) {
        if (!union.has(tool.name)) union.set(tool.name, tool);
      }
    }
    // The dispatch loop owns this container; executeToolCall only refuses
    // nested use explicitly instead of falling through to the ESI catalog.
    expect(tools.isReadSubagentBatchTool('delegate_read_subagents')).toBe(true);

    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db as never);
    const failures: string[] = [];
    try {
      for (const tool of union.values()) {
        const args = minimalValue(tool.parameters) as Record<string, unknown>;
        const registry = new EffectiveToolRegistry([{ ...tool, defer_loading: undefined } as NativeFunctionTool]);
        const validation = validateEffectiveToolCalls(registry, [{
          callId: `call_${tool.name}`, name: tool.name, argumentsText: JSON.stringify(args),
        }], new Set());
        if (!validation.ok || validation.rejections[0]) {
          failures.push(`${tool.name}: generated arguments are not schema-valid ${JSON.stringify(validation)}`);
          continue;
        }
        let result: unknown;
        try {
          result = await __test__.executeToolCall(
            db as never, 'req-surface', 'surface check', { userId: 1, chatId: 1 } as never,
            tool.name, args, createWebSearchState(),
          );
        } catch (error) {
          failures.push(`${tool.name}: threw ${String(error)}`);
          continue;
        }
        const serialized = JSON.stringify(result ?? null);
        if (!result || typeof result !== 'object') failures.push(`${tool.name}: non-object result ${serialized}`);
        else if (/Unknown ESI operation|Unknown Perimeter tool|unknown tool/i.test(serialized)) failures.push(`${tool.name}: no handler ${serialized.slice(0, 200)}`);
        else if ((result as Record<string, unknown>).internal_error === true) failures.push(`${tool.name}: handler threw internally`);
      }
    } finally {
      db.close();
    }
    expect(failures).toEqual([]);
    expect(union.size).toBeGreaterThan(90);
  }, 120_000);

  it('turns an unexpected handler throw into a per-call failure but lets cancellation propagate', async () => {
    vi.resetModules();
    const behaviour = { error: new Error('boom') };
    vi.doMock('../../src/eve-intel/notes.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/eve-intel/notes.js')>()),
      executeIntelNote: () => {
        throw behaviour.error;
      },
    }));
    try {
      const { __test__ } = await import('../../src/agent/executor.js');
      const { createWebSearchState } = await import('../../src/agent/web-search.js');
      const { TURN_DEADLINE_MESSAGE } = await import('../../src/agent/activity.js');
      const args = { action: 'list', text: null, system: null, region: null, entity_name: null, tag: null, query: null, note_id: null };
      const run = () => __test__.executeToolCall(
        {} as never, 'req-throw', 'throw check', { userId: 1, chatId: 1 } as never,
        'intel_note', args, createWebSearchState(),
      );
      expect(await run()).toMatchObject({ ok: false, internal_error: true });
      behaviour.error = new Error(TURN_DEADLINE_MESSAGE);
      await expect(run()).rejects.toThrow(TURN_DEADLINE_MESSAGE);
    } finally {
      vi.doUnmock('../../src/eve-intel/notes.js');
      vi.resetModules();
    }
  });

  it('keeps the dispatcher total: an undeclared name is refused, not silently executed', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    const { createWebSearchState } = await import('../../src/agent/web-search.js');
    const { SCHEMA_SQL } = await import('../../src/db/schema.js');
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    try {
      const result = await __test__.executeToolCall(
        db as never, 'req-surface', 'surface check', { userId: 1, chatId: 1 } as never,
        'definitely_not_a_tool', {}, createWebSearchState(),
      );
      expect(result).toMatchObject({ ok: false, status: 404 });
    } finally {
      db.close();
    }
  });
});

