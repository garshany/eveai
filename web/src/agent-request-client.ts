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
