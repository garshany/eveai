import { describe, expect, it } from 'vitest';
import type { NativeTool } from '../../src/agent/native-responses.js';
import {
  EffectiveToolRegistry,
  validateEffectiveToolCalls,
  validateToolSchemaDefinition,
} from '../../src/agent/tool-registry.js';

const eager: NativeTool = {
  type: 'function',
  name: 'eager_read',
  description: 'Eager test tool',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1 },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

const deferredNamespace: NativeTool = {
  type: 'namespace',
  name: 'private_namespace',
  description: 'Deferred test namespace',
  tools: [{
    type: 'function',
    name: 'deferred_read',
    description: 'Deferred test tool',
    strict: true,
    defer_loading: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 16 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  }],
};

describe('effective tool registry', () => {
  it('rejects an unloaded deferred tool and never treats its name as authority', () => {
    const registry = new EffectiveToolRegistry([eager]);
    const result = validateEffectiveToolCalls(registry, [{
      callId: 'call-1',
      name: 'deferred_read',
      argumentsText: '{"query":"wallet"}',
    }], new Set());

    expect(result).toMatchObject({
      ok: true,
      rejections: [{ ok: false, blocked: true, error: 'Tool was not declared for this turn' }],
    });
  });

  it('accepts a canonical deferred schema only after trusted loading', () => {
    const registry = new EffectiveToolRegistry([eager]);
    registry.add([deferredNamespace]);
    const result = validateEffectiveToolCalls(registry, [{
      callId: 'call-1',
      name: 'deferred_read',
      argumentsText: '{"query":"wallet"}',
    }], new Set());

    expect(result).toEqual({
      ok: true,
      args: [{ query: 'wallet' }],
      rejections: [undefined],
    });
  });

  it('rejects malformed, extra, and out-of-bounds arguments before dispatch', () => {
    const registry = new EffectiveToolRegistry([eager]);
    const malformed = validateEffectiveToolCalls(registry, [{
      callId: 'call-1', name: 'eager_read', argumentsText: '{bad',
    }], new Set());
    const extra = validateEffectiveToolCalls(registry, [{
      callId: 'call-2', name: 'eager_read', argumentsText: '{"id":1,"secret":"nope"}',
    }], new Set());
    const belowMinimum = validateEffectiveToolCalls(registry, [{
      callId: 'call-3', name: 'eager_read', argumentsText: '{"id":0}',
    }], new Set());

    expect(malformed).toMatchObject({ ok: true, rejections: [expect.objectContaining({ blocked: true })] });
    expect(extra).toMatchObject({ ok: true, rejections: [expect.objectContaining({ blocked: true })] });
    expect(belowMinimum).toMatchObject({ ok: true, rejections: [expect.objectContaining({ blocked: true })] });
  });

  it('fails the envelope for duplicate or replayed call IDs', () => {
    const registry = new EffectiveToolRegistry([eager]);
    expect(validateEffectiveToolCalls(registry, [
      { callId: 'same', name: 'eager_read', argumentsText: '{"id":1}' },
      { callId: 'same', name: 'eager_read', argumentsText: '{"id":2}' },
    ], new Set())).toEqual({ ok: false, error: 'Duplicate or missing function call id' });
    expect(validateEffectiveToolCalls(registry, [
      { callId: 'seen', name: 'eager_read', argumentsText: '{"id":1}' },
    ], new Set(['seen']))).toEqual({ ok: false, error: 'Duplicate or missing function call id' });
  });

  it('rejects a mixed valid and invalid batch atomically', () => {
    const registry = new EffectiveToolRegistry([eager]);
    const result = validateEffectiveToolCalls(registry, [
      { callId: 'valid', name: 'eager_read', argumentsText: '{"id":1}' },
      { callId: 'invalid', name: 'eager_read', argumentsText: '{"id":0}' },
    ], new Set());

    expect(result).toMatchObject({
      ok: true,
      rejections: [
        expect.objectContaining({ blocked: true }),
        expect.objectContaining({ blocked: true }),
      ],
    });
  });

  it('rejects unsupported schemas and conflicting canonical names', () => {
    expect(validateToolSchemaDefinition({ type: 'string', oneOf: [] })).toContain('unsupported');
    const registry = new EffectiveToolRegistry([eager]);
    expect(() => registry.add([{
      ...eager,
      description: 'Conflicting replacement',
    }])).toThrow('Conflicting tool definition');
  });

  it('reports deterministic unique load deltas and charges duplicates zero', () => {
    const registry = new EffectiveToolRegistry([eager]);

    const first = registry.add([deferredNamespace]);
    const repeated = registry.add([deferredNamespace]);

    expect(first).toMatchObject({
      functions: 1,
      namespaces: 1,
      newFunctionNames: ['deferred_read'],
      newNamespaceNames: ['private_namespace'],
    });
    expect(first.bytes).toBeGreaterThan(0);
    expect(repeated).toMatchObject({
      functions: 0,
      namespaces: 0,
      bytes: 0,
      alreadyLoadedFunctionNames: ['deferred_read'],
    });
  });

  it('does not partially mutate the registry when a batch conflicts', () => {
    const registry = new EffectiveToolRegistry([eager]);
    const newTool: NativeTool = {
      type: 'function',
      name: 'new_read',
      description: 'Would be valid alone',
      strict: true,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    };

    expect(() => registry.add([
      newTool,
      { ...eager, description: 'Conflicting replacement' },
    ])).toThrow('Conflicting tool definition');
    expect(registry.get('new_read')).toBeUndefined();
    expect(registry.names()).toEqual(['eager_read']);
  });
});
