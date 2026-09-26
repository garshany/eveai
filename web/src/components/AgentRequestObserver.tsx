import { useEffect } from 'react';
import { observeAgentRequest, type RequestObserverProps } from '../agent-request-observer';

/** Both main chat and Perimeter follow exactly the same request transport. */
export function RequestObserver({ requestId, threadId, retryAfterMs, onSnapshot, onDelta, onPollError }: RequestObserverProps) {
  useEffect(() => observeAgentRequest({ requestId, threadId, retryAfterMs, onSnapshot, onDelta, onPollError }),
    [requestId, threadId, retryAfterMs, onSnapshot, onDelta, onPollError]);
  return null;
}
