import { describe, expect, it, vi } from 'vitest';
import { AmbiguousApiRequestError } from '../../web/src/api.js';
import {
  mergeRequestSnapshot,
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
});

function request(overrides: Partial<WebAgentRequest>): WebAgentRequest {
  return {
    requestId: 'request-1',
    threadId: 'thread-1',
    status: 'running',
    activity: [],
    progressSequence: 1,
    result: null,
    error: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    retryAfterMs: 1_000,
    ...overrides,
  };
}
