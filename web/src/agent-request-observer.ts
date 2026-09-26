import { webApi } from './api';
import type { WebAgentRequest } from './types';
import type { StreamDeltaFrame } from './agent-request-client';

export type RequestObserverProps = {
  requestId: string;
  threadId: string;
  retryAfterMs: number;
  onSnapshot: (request: WebAgentRequest) => void;
  onDelta: (threadId: string, frame: StreamDeltaFrame) => void;
  onPollError: (message: string) => void;
};

/** Shared SSE protocol with a non-overlapping polling fallback and cleanup. */
export function observeAgentRequest({ requestId, threadId, retryAfterMs, onSnapshot, onDelta, onPollError }: RequestObserverProps): () => void {
  let cancelled = false;
  let timer: number | null = null;
  const applySnapshot = (request: WebAgentRequest) => {
    if (!cancelled) onSnapshot(request);
  };
  let polling = false;
  let inFlight = false;
  let lastFrameAt = Date.now();
  const controller = new AbortController();
  const poll = async () => {
    if (cancelled || inFlight || (!polling && Date.now() - lastFrameAt < 15_000)) return;
    inFlight = true;
    try {
      const { request } = await webApi.getAgentRequest(requestId, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      applySnapshot(request);
    } catch (reason) {
      if (!cancelled) onPollError(reason instanceof Error ? reason.message : 'Request status unavailable.');
    } finally {
      inFlight = false;
    }
  };
  const startPolling = () => { polling = true; void poll(); };
  timer = window.setInterval(() => { void poll(); }, Math.max(500, retryAfterMs));
  const source = typeof EventSource === 'undefined'
    ? null
    : new EventSource(`/api/web/chat/requests/${encodeURIComponent(requestId)}/events`);
  source?.addEventListener('request', (event) => {
    if (cancelled || !(event instanceof MessageEvent)) return;
    try {
      const payload = JSON.parse(event.data) as { request?: WebAgentRequest };
      if (payload.request?.requestId === requestId) { lastFrameAt = Date.now(); applySnapshot(payload.request); }
    } catch {
      // A malformed frame is skipped; the next snapshot carries full state.
    }
  });
  source?.addEventListener('delta', (event) => {
    if (cancelled || !(event instanceof MessageEvent)) return;
    try {
      const frame = JSON.parse(event.data) as StreamDeltaFrame;
      if (frame.requestId === requestId) { lastFrameAt = Date.now(); onDelta(threadId, frame); }
    } catch {
      // A malformed frame is skipped; the next snapshot carries full state.
    }
  });
  source?.addEventListener('error', () => {
    source.close();
    startPolling();
  });
  if (!source) startPolling();
  return () => {
    cancelled = true;
    controller.abort();
    source?.close();
    if (timer !== null) window.clearInterval(timer);
  };
}
