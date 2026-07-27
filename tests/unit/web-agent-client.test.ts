import { describe, expect, it, vi } from 'vitest';
import { AmbiguousApiRequestError } from '../../web/src/api.js';
import {
  mergeRequestSnapshot,
  mergeStreamDelta,
  preparePendingSubmission,
  submitWithAmbiguousRetry,
} from '../../web/src/agent-request-client.js';
import type { WebAgentRequest } from '../../web/src/types.js';

describe('web agent request client lifecycle', () => {
  it('reuses the exact idempotency key for an ambiguous retry', async () => {
    const createKey = vi.fn(() => 'stable-key');
    const first = preparePendingSubmission(null, 'route', 'thread-1', createKey);
    const retry = preparePendingSubmission(first.submission, 'route', 'thread-1', createKey);

    expect(retry).toEqual({ submission: first.submission, retrying: true });
    expect(createKey).toHaveBeenCalledTimes(1);

    const submit = vi.fn()
      .mockRejectedValueOnce(new AmbiguousApiRequestError('lost 202'))
      .mockResolvedValueOnce({ accepted: true });
    await expect(submitWithAmbiguousRetry(submit)).resolves.toEqual({ accepted: true });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('does not retry definite API rejections', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('rate limited'));
    await expect(submitWithAmbiguousRetry(submit)).rejects.toThrow('rate limited');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps the same state object for duplicate SSE snapshots', () => {
    const current = request({ progressSequence: 2, status: 'running' });
    const duplicate = request({ progressSequence: 2, status: 'running' });
    const advanced = request({ progressSequence: 3, status: 'completed' });

    expect(mergeRequestSnapshot(current, duplicate)).toBe(current);
    expect(mergeRequestSnapshot(current, advanced)).toBe(advanced);
  });

  it('applies a stream delta only for a newer sequence of the same request', () => {
    const current = request({ progressSequence: 2, streamText: 'partial' });

    const accepted = mergeStreamDelta(current, { requestId: 'request-1', text: 'partial answer', sequence: 3 });
    expect(accepted).toMatchObject({ streamText: 'partial answer', progressSequence: 3 });

    expect(mergeStreamDelta(current, { requestId: 'request-1', text: 'stale', sequence: 2 })).toBe(current);
    expect(mergeStreamDelta(current, { requestId: 'request-1', text: 'older', sequence: 1 })).toBe(current);
    expect(mergeStreamDelta(current, { requestId: 'request-2', text: 'foreign', sequence: 9 })).toBe(current);
    expect(mergeStreamDelta(null, { requestId: 'request-1', text: 'orphan', sequence: 3 })).toBeNull();
  });

  it('keeps delta-streamed text against older snapshots and accepts newer snapshots wholesale', () => {
    const streamed = mergeStreamDelta(
      request({ progressSequence: 2, streamText: 'par' }),
      { requestId: 'request-1', text: 'partial ans', sequence: 4 },
    );

    const staleSnapshot = request({ progressSequence: 3, streamText: 'par' });
    expect(mergeRequestSnapshot(streamed, staleSnapshot)).toBe(streamed);

    const sameSequenceSnapshot = request({ progressSequence: 4, status: 'running', streamText: 'partial ans' });
    expect(mergeRequestSnapshot(streamed, sameSequenceSnapshot)).toBe(streamed);

    const advancedSnapshot = request({ progressSequence: 5, streamText: 'partial answer fina' });
    expect(mergeRequestSnapshot(streamed, advancedSnapshot)).toBe(advancedSnapshot);
  });
});

function request(overrides: Partial<WebAgentRequest>): WebAgentRequest {
  return {
    requestId: 'request-1',
    threadId: 'thread-1',
    status: 'running',
    activity: [],
    progressSequence: 1,
    streamText: '',
    result: null,
    error: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    retryAfterMs: 1_000,
    ...overrides,
  };
}
