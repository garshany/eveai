import { describe, expect, it, vi } from 'vitest';
import type {
  NativeFunctionTool,
  NativeResponseResult,
} from '../../src/agent/native-responses.js';
import { createNativeResponse } from '../../src/agent/native-responses.js';
import {
  MAX_TOTAL_TURN_READ_LEAVES,
  runReadSubagentBatch,
  validateReadSubagentBatch,
} from '../../src/agent/read-subagents.js';

const countTool: NativeFunctionTool = {
  type: 'function',
  name: 'count_universe_objects',
  description: 'Count public static objects',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      target_kind: { type: 'string', enum: ['region'] },
      target_name: { type: 'string', minLength: 1 },
      object_kind: { type: 'string', enum: ['systems'] },
    },
    required: ['target_kind', 'target_name', 'object_kind'],
    additionalProperties: false,
  },
};

function response(output: Array<Record<string, unknown>>, outputText = ''): NativeResponseResult {
  return {
    id: null,
    output,
    outputText,
    error: null,
    toolSearchPaths: [],
    rawEvents: [],
    usage: null,
    status: 'completed',
  };
}

function tasks(): Record<string, unknown> {
  return {
    tasks: [
      { id: 'forge', objective: 'Count systems in The Forge', tool_hints: ['count_universe_objects'] },
      { id: 'domain', objective: 'Count systems in Domain region', tool_hints: ['count_universe_objects'] },
      { id: 'sinq', objective: 'Count systems in Sinq Laison', tool_hints: ['count_universe_objects'] },
    ],
  };
}

describe('read-only subagents', () => {
  it('rejects duplicate jobs, extra fields, and forbidden tools atomically', () => {
    expect(validateReadSubagentBatch({
      tasks: [
        { id: 'same', objective: 'Count systems in The Forge', tool_hints: ['count_universe_objects'] },
        { id: 'same', objective: 'Count systems in Domain region', tool_hints: ['count_universe_objects'] },
      ],
    })).toBeNull();
    expect(validateReadSubagentBatch({
      tasks: [
        { id: 'one', objective: 'Build a route to Jita', tool_hints: ['plan_route'] },
        { id: 'two', objective: 'Set autopilot to Amarr', tool_hints: ['plan_route'] },
      ],
      extra: true,
    })).toBeNull();
  });

  it('bounds concurrency, preserves task order, and aggregates grounded evidence', async () => {
    let active = 0;
    let peak = 0;
    const dispatch = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return {
        ok: true,
        target_kind: 'region',
        target_name: args.target_name,
        object_kind: 'systems',
        count: 42,
      };
    });
    const responseFactory = vi.fn(async (input: Parameters<typeof createNativeResponse>[0]) => {
      const hasOutput = input.items.some((item) => item.type === 'function_call_output');
      if (hasOutput) {
        return response([{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Grounded count collected.' }],
        }], 'Grounded count collected.');
      }
      const objective = JSON.stringify(input.items);
      const target = objective.includes('Domain') ? 'Domain'
        : objective.includes('Sinq') ? 'Sinq Laison' : 'The Forge';
      return response([{
        type: 'function_call',
        call_id: `call_${target.replace(/\s/gu, '_')}`,
        name: 'count_universe_objects',
        arguments: JSON.stringify({ target_kind: 'region', target_name: target, object_kind: 'systems' }),
      }]);
    });

    const result = await runReadSubagentBatch(tasks(), {
      toolsFor: () => [countTool],
      dispatch: dispatch as never,
      responseFactory,
      concurrency: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(peak).toBe(2);
    expect(result.results.map((item) => item.id)).toEqual(['forge', 'domain', 'sinq']);
    expect(result.results.every((item) => item.status === 'completed')).toBe(true);
    expect(result.results.every((item) => item.evidence.length === 1)).toBe(true);
    expect(result.usage).toEqual({ model_calls: 6, tool_leaves: 3 });
  });

  it('keeps successful sibling evidence when another worker fails', async () => {
    const responseFactory = vi.fn(async (input: Parameters<typeof createNativeResponse>[0]) => {
      const serialized = JSON.stringify(input.items);
      if (serialized.includes('Domain')) throw new Error('private upstream detail');
      if (input.items.some((item) => item.type === 'function_call_output')) {
        return response([{
          type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Evidence ready.' }],
        }], 'Evidence ready.');
      }
      return response([{
        type: 'function_call', call_id: 'call_ok', name: 'count_universe_objects',
        arguments: '{"target_kind":"region","target_name":"The Forge","object_kind":"systems"}',
      }]);
    });
    const result = await runReadSubagentBatch({
      tasks: (tasks().tasks as unknown[]).slice(0, 2),
    }, {
      toolsFor: () => [countTool],
      dispatch: async () => ({
        ok: true, target_kind: 'region', target_name: 'The Forge', object_kind: 'systems', count: 88,
      }),
      responseFactory,
      concurrency: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ id: 'forge', status: 'completed' });
    expect(result.results[1]).toMatchObject({ id: 'domain', status: 'failed' });
    expect(JSON.stringify(result)).not.toContain('private upstream detail');
  });

  it('never dispatches an undeclared or mutation tool returned by a worker', async () => {
    const dispatch = vi.fn();
    const responseFactory = vi.fn()
      .mockResolvedValueOnce(response([{
        type: 'function_call', call_id: 'bad_1', name: 'plan_route', arguments: '{}',
      }]))
      .mockResolvedValueOnce(response([{
        type: 'function_call', call_id: 'bad_2', name: 'plan_route', arguments: '{}',
      }]));
    const result = await runReadSubagentBatch({
      tasks: (tasks().tasks as unknown[]).slice(0, 2),
    }, {
      toolsFor: () => [countTool],
      dispatch,
      responseFactory,
      concurrency: 2,
    });

    expect(result.ok).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('shares the 24-leaf ceiling with prerequisite root reads', async () => {
    const dispatch = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      ok: true,
      target_kind: 'region',
      target_name: args.target_name,
      object_kind: 'systems',
      count: 1,
    }));
    const responseFactory = vi.fn(async (input: Parameters<typeof createNativeResponse>[0]) => {
      if (input.items.some((item) => item.type === 'function_call_output')) {
        return response([{
          type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }],
        }], 'Done.');
      }
      const target = JSON.stringify(input.items).includes('Domain') ? 'Domain' : 'The Forge';
      return response([{
        type: 'function_call', call_id: `call_${target}`, name: 'count_universe_objects',
        arguments: JSON.stringify({ target_kind: 'region', target_name: target, object_kind: 'systems' }),
      }]);
    });
    const budget = { modelCalls: 0, toolLeaves: MAX_TOTAL_TURN_READ_LEAVES - 1 };

    const result = await runReadSubagentBatch({
      tasks: (tasks().tasks as unknown[]).slice(0, 2),
    }, {
      toolsFor: () => [countTool],
      dispatch: dispatch as never,
      responseFactory,
      concurrency: 2,
      budget,
    });

    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(budget.toolLeaves).toBe(MAX_TOTAL_TURN_READ_LEAVES);
  });

  it('honours an explicit maxTasks limit override', async () => {
    const result = await runReadSubagentBatch(tasks(), {
      toolsFor: () => [countTool],
      dispatch: async () => ({ ok: true }),
      limits: { maxTasks: 2 },
    });

    expect(result).toEqual({ ok: false, blocked: true, error: 'Invalid read subagent batch' });
  });

  it('honours an explicit model-call budget override', async () => {
    const responseFactory = vi.fn(async () => response([{
      type: 'function_call', call_id: 'call_1', name: 'count_universe_objects',
      arguments: '{"target_kind":"region","target_name":"The Forge","object_kind":"systems"}',
    }]));

    const result = await runReadSubagentBatch({
      tasks: (tasks().tasks as unknown[]).slice(0, 2),
    }, {
      toolsFor: () => [countTool],
      dispatch: async () => ({
        ok: true, target_kind: 'region', target_name: 'The Forge', object_kind: 'systems', count: 1,
      }),
      responseFactory,
      concurrency: 1,
      limits: { maxTotalModelCalls: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.filter((item) => item.status !== 'failed').length).toBeLessThan(2);
    expect(responseFactory).toHaveBeenCalledTimes(1);
  });

  it('runs worker model calls on the caller-provided model and reports their usage', async () => {
    const usage = { input: 11, output: 5, total: 16, cached: 2, cacheWrite: 0, reasoning: 1 };
    const responseFactory = vi.fn(async (_input: Parameters<typeof createNativeResponse>[0]) => ({
      ...response([{
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'No grounded data.' }],
      }], 'No grounded data.'),
      usage,
    }));
    const recordUsage = vi.fn();

    const result = await runReadSubagentBatch(tasks(), {
      toolsFor: () => [countTool],
      dispatch: async () => ({ ok: true }),
      responseFactory,
      concurrency: 2,
      model: 'gpt-5.6-luna',
      recordUsage,
    });

    expect(result.ok).toBe(true);
    expect(responseFactory).toHaveBeenCalledTimes(3);
    for (const call of responseFactory.mock.calls) {
      expect(call[0]!.model).toBe('gpt-5.6-luna');
    }
    // One usage report per worker model call — the turn owner bills them all.
    expect(recordUsage).toHaveBeenCalledTimes(3);
    for (const call of recordUsage.mock.calls) {
      expect(call[0]).toEqual(usage);
    }
  });
});
