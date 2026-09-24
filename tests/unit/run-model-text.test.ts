import { afterEach, describe, expect, it, vi } from 'vitest';

const createNativeResponse = vi.fn();

vi.mock('../../src/agent/native-responses.js', () => ({
  createNativeResponse: (...args: unknown[]) => createNativeResponse(...args),
  toNativeMessage: (text: string) => ({ type: 'message', role: 'user', content: text }),
}));

const { runModelText } = await import('../../src/agent/model.js');

const usage = { input: 10, output: 5, total: 15, cached: 0, cacheWrite: 0, reasoning: 3 };

afterEach(() => {
  createNativeResponse.mockReset();
});

describe('runModelText', () => {
  it('records billed usage before throwing on a failed response', async () => {
    createNativeResponse.mockResolvedValue({
      outputText: '', usage, status: 'incomplete', error: { message: 'max_output_tokens' },
    });
    const onUsage = vi.fn();

    await expect(runModelText('dev', 'user', undefined, onUsage)).rejects.toThrow('max_output_tokens');
    expect(onUsage).toHaveBeenCalledWith(usage);
  });

  it('records usage and returns trimmed text on success', async () => {
    createNativeResponse.mockResolvedValue({ outputText: '  hi  ', usage, status: 'completed', error: null });
    const onUsage = vi.fn();

    await expect(runModelText('dev', 'user', undefined, onUsage)).resolves.toBe('hi');
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('throws without calling onUsage when no usage was reported', async () => {
    createNativeResponse.mockResolvedValue({ outputText: '', usage: null, status: 'failed', error: { message: 'boom' } });
    const onUsage = vi.fn();

    await expect(runModelText('dev', 'user', undefined, onUsage)).rejects.toThrow('boom');
    expect(onUsage).not.toHaveBeenCalled();
  });
});
