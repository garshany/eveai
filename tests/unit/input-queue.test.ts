import { describe, expect, it, vi } from 'vitest';
import { createInputQueue } from '../../src/cli/input-queue.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createInputQueue', () => {
  it('processes buffered lines strictly one at a time, in order', async () => {
    const events: string[] = [];
    let inFlight = 0;
    const queue = createInputQueue({
      handleLine: async (line) => {
        inFlight += 1;
        expect(inFlight).toBe(1); // never concurrent
        events.push(`start:${line}`);
        await tick();
        events.push(`end:${line}`);
        inFlight -= 1;
        return false;
      },
      onDrained: () => events.push('drained'),
      onError: () => {},
    });

    // Paste/pipe delivers everything at once.
    queue.push('a');
    queue.push('b');
    queue.push('c');
    expect(queue.isBusy()).toBe(true);
    expect(queue.size()).toBe(2);

    await vi.waitFor(() => expect(events).toContain('drained'));
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c', 'drained']);
    expect(queue.isBusy()).toBe(false);
  });

  it('keeps draining after a handler error and reports it', async () => {
    const handled: string[] = [];
    const errors: unknown[] = [];
    let drained = false;
    const queue = createInputQueue({
      handleLine: async (line) => {
        if (line === 'boom') throw new Error('db down');
        handled.push(line);
        return false;
      },
      onDrained: () => { drained = true; },
      onError: (err) => errors.push(err),
    });

    queue.push('boom');
    queue.push('after');
    await vi.waitFor(() => expect(drained).toBe(true));
    expect(handled).toEqual(['after']);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('db down');
  });

  it('passes through prompt suppression from the last handled line', async () => {
    const drains: boolean[] = [];
    const queue = createInputQueue({
      handleLine: async (line) => line === 'abandoned',
      onDrained: (suppressed) => { drains.push(suppressed); },
      onError: () => {},
    });

    queue.push('normal');
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    expect(drains[0]).toBe(false);

    queue.push('abandoned');
    await vi.waitFor(() => expect(drains).toHaveLength(2));
    expect(drains[1]).toBe(true);
  });

  it('lines pushed while draining are handled by the running pump', async () => {
    const handled: string[] = [];
    let drainCount = 0;
    const queue = createInputQueue({
      handleLine: async (line) => {
        handled.push(line);
        if (line === 'first') queue.push('injected');
        await tick();
        return false;
      },
      onDrained: () => { drainCount += 1; },
      onError: () => {},
    });

    queue.push('first');
    await vi.waitFor(() => expect(drainCount).toBeGreaterThan(0));
    expect(handled).toEqual(['first', 'injected']);
    expect(drainCount).toBe(1);
  });
});
