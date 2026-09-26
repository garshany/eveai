import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeAgentRequest } from '../../web/src/agent-request-observer.js';
import { webApi } from '../../web/src/api.js';
import { isRequestActive, mergeRequestSnapshot, mergeStreamDelta } from '../../web/src/agent-request-client.js';
import { perimeterElapsedSeconds } from '../../web/src/components/map/perimeter-chat-state.js';
import type { WebAgentRequest } from '../../web/src/types.js';

vi.mock('../../web/src/api.js', () => ({ webApi: { getAgentRequest: vi.fn() } }));
class Source extends EventTarget {
  static last: Source;
  close = vi.fn();
  constructor(public url: string) { super(); Source.last = this; }
  emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
}
const running: WebAgentRequest = {
  requestId: 'request-1', threadId: 'thread-1', status: 'running', progressSequence: 1,
  streamText: '', activity: [], result: null, error: null, createdAt: '2026-01-01 00:00:00',
  startedAt: null, finishedAt: null, retryAfterMs: 2000,
};
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('EventSource', Source);
  vi.mocked(webApi.getAgentRequest).mockReset().mockResolvedValue({ request: running });
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
const listen = () => {
  const onSnapshot = vi.fn(); const onDelta = vi.fn(); const onPollError = vi.fn();
  stop = observeAgentRequest({ requestId: running.requestId, threadId: running.threadId, retryAfterMs: 2000, onSnapshot, onDelta, onPollError });
  return { onSnapshot, onDelta, onPollError };
};
describe('shared Perimeter/main chat observer', () => {
  it('uses request/delta SSE frames without polling a healthy stream', async () => {
    const handlers = listen();
    expect(Source.last.url).toBe('/api/web/chat/requests/request-1/events');
    Source.last.emit('request', { request: running });
    Source.last.emit('delta', { requestId: running.requestId, text: '**Hello**', sequence: 2 });
    Source.last.emit('request', { request: { ...running, requestId: 'other' } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(handlers.onSnapshot).toHaveBeenCalledExactlyOnceWith(running);
    expect(handlers.onDelta).toHaveBeenCalledWith(running.threadId, { requestId: running.requestId, text: '**Hello**', sequence: 2 });
    expect(webApi.getAgentRequest).not.toHaveBeenCalled();
  });
  it('polls on stream failure and keeps queued/running requests active', async () => {
    const handlers = listen();
    Source.last.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(webApi.getAgentRequest).toHaveBeenCalledTimes(3);
    expect(handlers.onSnapshot).toHaveBeenCalledWith(running);
    expect(isRequestActive(running)).toBe(true);
    expect(isRequestActive({ ...running, status: 'queued' })).toBe(true);
    expect(isRequestActive({ ...running, status: 'failed' })).toBe(false);
  });
  it('recovers a silent socket and never overlaps polls', async () => {
    vi.mocked(webApi.getAgentRequest).mockReturnValue(new Promise(() => {}));
    listen();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(webApi.getAgentRequest).toHaveBeenCalledTimes(1);
  });
  it('does not apply an in-flight poll or stream frame after cleanup/reset', async () => {
    let finish!: (value: { request: WebAgentRequest }) => void;
    vi.mocked(webApi.getAgentRequest).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const handlers = listen();
    Source.last.dispatchEvent(new Event('error'));
    stop!();
    finish({ request: running });
    Source.last.emit('request', { request: running });
    Source.last.emit('delta', { requestId: running.requestId, text: 'old', sequence: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
    expect(handlers.onDelta).not.toHaveBeenCalled();
    expect(webApi.getAgentRequest).toHaveBeenCalledTimes(1);
    expect(Source.last.close).toHaveBeenCalled();
  });
  it('reports failed polls and works when EventSource is unavailable', async () => {
    vi.stubGlobal('EventSource', undefined);
    vi.mocked(webApi.getAgentRequest).mockRejectedValue(new Error('offline'));
    const handlers = listen();
    await vi.advanceTimersByTimeAsync(1);
    expect(handlers.onPollError).toHaveBeenCalledWith('offline');
  });
  it('rejects out-of-order text and preserves terminal snapshots', () => {
    const streamed = mergeStreamDelta(running, { requestId: running.requestId, text: 'partial', sequence: 2 });
    expect(mergeRequestSnapshot(streamed, running)).toBe(streamed);
    expect(mergeStreamDelta(streamed, { requestId: running.requestId, text: 'stale', sequence: 1 })).toBe(streamed);
    const done = { ...running, status: 'completed' as const, progressSequence: 3 };
    expect(mergeRequestSnapshot(streamed, done)).toBe(done);
  });
  it('shows a finite timer before acceptance and interprets SQL timestamps as UTC', () => {
    expect(perimeterElapsedSeconds(undefined, 5000, 1000)).toBe(4);
    expect(perimeterElapsedSeconds('bad timestamp', 5000, 1000)).toBe(4);
    expect(perimeterElapsedSeconds('2026-01-01 00:00:00', Date.parse('2026-01-01T00:01:01Z'), 0)).toBe(61);
  });
});
