import { isAmbiguousApiRequestError } from './api';
import type { WebAgentRequest } from './types';

export type PendingSubmission = {
  content: string;
  threadId: string | null;
  idempotencyKey: string;
};

export function preparePendingSubmission(
  previous: PendingSubmission | null,
  content: string,
  threadId: string | null,
  createKey: () => string,
): { submission: PendingSubmission; retrying: boolean } {
  if (previous?.content === content && previous.threadId === threadId) {
    return { submission: previous, retrying: true };
  }
  return {
    submission: { content, threadId, idempotencyKey: createKey() },
    retrying: false,
  };
}

export async function submitWithAmbiguousRetry<T>(submit: () => Promise<T>): Promise<T> {
  try {
    return await submit();
  } catch (error) {
    if (!isAmbiguousApiRequestError(error)) throw error;
    return await submit();
  }
}

export type StreamDeltaFrame = {
  requestId: string;
  text: string;
  sequence: number;
};

export function mergeStreamDelta(
  current: WebAgentRequest | null,
  frame: StreamDeltaFrame,
): WebAgentRequest | null {
  if (!current || current.requestId !== frame.requestId) return current;
  if (frame.sequence <= current.progressSequence) return current;
  return { ...current, streamText: frame.text, progressSequence: frame.sequence };
}

export function mergeRequestSnapshot(
  current: WebAgentRequest | null,
  incoming: WebAgentRequest,
): WebAgentRequest | null {
  if (!current || current.requestId !== incoming.requestId) return current;
  if (
    incoming.progressSequence < current.progressSequence
    || (
      incoming.progressSequence === current.progressSequence
      && incoming.status === current.status
    )
  ) return current;
  return incoming;
}

/**
 * Agent turns in flight, one per conversation thread. Every chat keeps its own
 * live turn, so a reply streaming in one chat never locks the others.
 */
export type RequestsByThread = Readonly<Record<string, WebAgentRequest>>;

export function isRequestActive(request: WebAgentRequest | null | undefined): boolean {
  return request?.status === 'queued' || request?.status === 'running';
}

/** Tracks a newly submitted or recovered request; a newer one for the thread replaces the old. */
export function trackThreadRequest(requests: RequestsByThread, request: WebAgentRequest): RequestsByThread {
  const current = requests[request.threadId];
  if (current?.requestId === request.requestId) return applyThreadSnapshot(requests, request);
  return { ...requests, [request.threadId]: request };
}

export function applyThreadSnapshot(requests: RequestsByThread, incoming: WebAgentRequest): RequestsByThread {
  const current = requests[incoming.threadId] ?? null;
  const merged = mergeRequestSnapshot(current, incoming);
  if (!merged || merged === current) return requests;
  return { ...requests, [incoming.threadId]: merged };
}

export function applyThreadDelta(
  requests: RequestsByThread,
  threadId: string,
  frame: StreamDeltaFrame,
): RequestsByThread {
  const current = requests[threadId] ?? null;
  const merged = mergeStreamDelta(current, frame);
  if (!merged || merged === current) return requests;
  return { ...requests, [threadId]: merged };
}

/** Drops a finished request, unless the thread already moved on to a newer one. */
export function untrackThreadRequest(
  requests: RequestsByThread,
  threadId: string,
  requestId: string,
): RequestsByThread {
  if (requests[threadId]?.requestId !== requestId) return requests;
  const next = { ...requests };
  delete next[threadId];
  return next;
}
