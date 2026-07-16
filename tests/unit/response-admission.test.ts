import { describe, expect, it } from 'vitest';
import { ResponseAdmissionController } from '../../src/agent/response-admission.js';

describe('response admission', () => {
  it('uses a bounded FIFO queue and releases slots exactly once', async () => {
    const admission = new ResponseAdmissionController({
      maxConcurrent: 1,
      maxQueued: 2,
      queueTimeoutMs: 1_000,
    });
    const firstRelease = await admission.acquire();
    const order: string[] = [];
    const second = admission.acquire().then((release) => {
      order.push('second');
      return release;
    });
    const third = admission.acquire().then((release) => {
      order.push('third');
      return release;
    });
    await expect(admission.acquire()).rejects.toThrow('queue is full');
    expect(admission.snapshot()).toEqual({ active: 1, queued: 2 });

    firstRelease();
    firstRelease();
    const secondRelease = await second;
    expect(order).toEqual(['second']);
    secondRelease();
    const thirdRelease = await third;
    expect(order).toEqual(['second', 'third']);
    thirdRelease();
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('removes timed-out waiters without leaking capacity', async () => {
    const admission = new ResponseAdmissionController({
      maxConcurrent: 1,
      maxQueued: 1,
      queueTimeoutMs: 20,
    });
    const release = await admission.acquire();
    await expect(admission.acquire()).rejects.toThrow('queue timed out');
    expect(admission.snapshot()).toEqual({ active: 1, queued: 0 });
    release();
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('removes an aborted queued waiter and immediately restores capacity', async () => {
    const admission = new ResponseAdmissionController({
      maxConcurrent: 1,
      maxQueued: 2,
      queueTimeoutMs: 1_000,
      label: 'Subagent response',
    });
    const release = await admission.acquire();
    const controller = new AbortController();
    const queued = admission.acquire(controller.signal);
    expect(admission.snapshot()).toEqual({ active: 1, queued: 1 });
    controller.abort();
    await expect(queued).rejects.toThrow('admission aborted');
    expect(admission.snapshot()).toEqual({ active: 1, queued: 0 });
    release();
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0 });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(admission.acquire(alreadyAborted.signal)).rejects.toThrow('admission aborted');
  });
});
