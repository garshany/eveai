import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  delete process.env.OPENAI_PROVIDER;
  vi.resetModules();
});

describe('local parallel batch', () => {
  it('validates atomically and executes bounded public calls concurrently in stable order', async () => {
    process.env.OPENAI_PROVIDER = 'cheapvibecode';
    process.env.OPENAI_RESPONSE_STATE_MODE = 'stateless';
    process.env.OPENAI_STORE_RESPONSES = 'false';
    vi.resetModules();
    const { __test__ } = await import('../../src/agent/executor.js');
    const args = {
      calls: [
        {
          id: 'systems',
          tool: 'count_universe_objects',
          arguments_json: JSON.stringify({
            target_kind: 'region', target_name: 'The Forge', object_kind: 'systems',
          }),
        },
        {
          id: 'planets',
          tool: 'count_universe_objects',
          arguments_json: JSON.stringify({
            target_kind: 'region', target_name: 'The Forge', object_kind: 'planets',
          }),
        },
      ],
    };
    const state = { callsExecuted: 0 };
    const started = Date.now();
    const result = await __test__.executeLocalParallelBatch(
      args,
      state,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new Error('raw upstream detail must not escape');
      },
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(110);
    expect(state.callsExecuted).toBe(2);
    expect((result.results as Array<Record<string, unknown>>).map((entry) => entry.id))
      .toEqual(['systems', 'planets']);
    expect(JSON.stringify(result)).not.toContain('raw upstream detail');
  });

  it('rejects a forbidden tool and extra fields before dispatch', async () => {
    process.env.OPENAI_PROVIDER = 'cheapvibecode';
    vi.resetModules();
    const { __test__ } = await import('../../src/agent/executor.js');
    const dispatch = vi.fn(async () => ({ ok: true }));
    const state = { callsExecuted: 0 };
    const result = await __test__.executeLocalParallelBatch({
      calls: [{
        id: 'nope',
        tool: 'sde_sql',
        arguments_json: '{"sql":"SELECT 1"}',
        extra: true,
      }],
    }, state, dispatch);

    expect(result).toMatchObject({ ok: false, blocked: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.callsExecuted).toBe(0);
  });
});
