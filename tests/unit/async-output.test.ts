import { describe, expect, it, vi } from 'vitest';
import { createCliAsyncOutput } from '../../src/cli/async-output.js';

describe('CLI asynchronous output', () => {
  it('redraws an idle readline prompt after sanitized delivery', async () => {
    const writes: string[] = [];
    const prompt = vi.fn();
    const output = createCliAsyncOutput({
      write: (text) => writes.push(text),
      isTty: true,
      render: (text) => `rendered(${text})`,
      sanitize: (text) => text.replace('secret', '[REDACTED]'),
      prompt,
      activeRenderer: () => null,
    });

    await output.deliver('secret alert');

    expect(writes).toEqual(['\r\x1b[K', '🔔 rendered([REDACTED] alert)\n']);
    expect(prompt).toHaveBeenCalledWith(true);
  });

  it('serializes active-turn alerts through the renderer and closes fail-closed', async () => {
    const notify = vi.fn(() => true);
    const renderer = { notify } as never;
    const output = createCliAsyncOutput({
      write: vi.fn(),
      isTty: true,
      render: String,
      sanitize: String,
      prompt: vi.fn(),
      activeRenderer: () => renderer,
    });

    await Promise.all([output.deliver('one'), output.deliver('two')]);
    expect(notify.mock.calls).toEqual([['one'], ['two']]);
    await output.close();
    await expect(output.deliver('late')).rejects.toThrow('closed');
  });

  it('falls back to prompt-safe output when an aborted renderer rejects the alert', async () => {
    const writes: string[] = [];
    const prompt = vi.fn();
    const output = createCliAsyncOutput({
      write: (text) => writes.push(text),
      isTty: true,
      render: (text) => `rendered(${text})`,
      sanitize: String,
      prompt,
      activeRenderer: () => ({ notify: () => false }) as never,
    });

    await output.deliver('durable alert');

    expect(writes).toEqual(['\r\x1b[K', '🔔 rendered(durable alert)\n']);
    expect(prompt).toHaveBeenCalledWith(true);
  });
});
