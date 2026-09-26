import { useCallback, useEffect, useRef, useState } from 'react';
import { isAmbiguousApiRequestError, webApi } from '../../api';
import { isRequestActive, mergeRequestSnapshot, mergeStreamDelta, submitWithAmbiguousRetry, preparePendingSubmission, type PendingSubmission, type StreamDeltaFrame } from '../../agent-request-client';
import { useI18n } from '../../i18n';
import type { PerimeterMessage, WebAgentRequest } from '../../types';
import type { MapAskContext } from './PerimeterChat';
import type { LiveAdvisory } from './use-map-live';
import { mergeAdvisoryMessages } from './live-merge';
import { mergePerimeterHistory, PerimeterHistoryGate } from './perimeter-chat-state';

export function usePerimeterChat(csrfToken: string, advisories: LiveAdvisory[], context: MapAskContext) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<PerimeterMessage[]>([]);
  const [request, setRequest] = useState<WebAgentRequest | null>(null);
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const thread = useRef<string | null>(null);
  const generation = useRef(0);
  const gate = useRef(new PerimeterHistoryGate());
  const mounted = useRef(false);
  const mutation = useRef(false);
  const active = useRef<WebAgentRequest | null>(null);
  const pending = useRef<PendingSubmission | null>(null);
  const latest = useRef({ context, t, advisories });
  latest.current = { context, t, advisories };
  active.current = request;

  const reload = useCallback(async () => {
    const ticket = gate.current.begin();
    const payload = await webApi.map.chat();
    if (!mounted.current || !gate.current.accepts(ticket)) return;
    const changed = thread.current !== payload.threadId;
    if (changed) {
      generation.current++;
      thread.current = payload.threadId;
      setRequest(null);
    }
    setMessages((previous) => mergeAdvisoryMessages(
      mergePerimeterHistory(changed ? [] : previous, payload.messages),
      latest.current.advisories.filter((entry) => entry.threadId === payload.threadId).map((entry) => entry.message),
      0,
    ));
    setLoaded(true);
    // Recover a running turn after navigation/reload, on the same request lane.
    if (!isRequestActive(active.current) || changed) {
      const recovered = await webApi.getActiveAgentRequest(payload.threadId);
      if (mounted.current && gate.current.accepts(ticket) && thread.current === payload.threadId && !mutation.current) {
        setRequest((current) => isRequestActive(current) ? current : recovered.request);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    void reload().catch(() => { if (mounted.current) setError(latest.current.t('pchatHistoryError')); });
  }, [reload]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = window.setInterval(() => {
      if (!mutation.current && document.visibilityState !== 'hidden') refresh();
    }, 20_000);
    return () => {
      mounted.current = false;
      generation.current++;
      gate.current.invalidate();
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (mutation.current || !thread.current) return;
    // The live hook empties its replay buffer on chat-reset. Refresh immediately
    // in other tabs as well; the initiating tab is protected by mutation/gate.
    if (advisories.length === 0 || advisories.some((entry) => entry.threadId !== thread.current)) {
      refresh();
      return;
    }
    setMessages((previous) => mergeAdvisoryMessages(previous, advisories.map((entry) => entry.message), 0));
  }, [advisories, refresh]);

  const onSnapshot = useCallback((incoming: WebAgentRequest) => {
    if (incoming.threadId !== thread.current || mutation.current) return;
    setError((current) => current === latest.current.t('pchatConnectionError') ? null : current);
    setRequest((current) => mergeRequestSnapshot(current, incoming));
  }, []);
  const onDelta = useCallback((_threadId: string, frame: StreamDeltaFrame) => {
    if (!mutation.current) setRequest((current) => mergeStreamDelta(current, frame));
  }, []);
  const onPollError = useCallback(() => setError(latest.current.t('pchatConnectionError')), []);

  const terminalId = request && !isRequestActive(request) ? request.requestId : null;
  useEffect(() => {
    if (!terminalId || !request) return;
    if (request.status === 'completed') setError(null);
    if (request.status === 'failed') setError(request.error || t('requestFailed'));
    if (request.status === 'cancelled') setError(t('pchatCancelled'));
    refresh();
  }, [terminalId, refresh]);

  const requestId = request?.requestId;
  const running = isRequestActive(request);
  useEffect(() => {
    if (!requestId || !running) return;
    const timer = window.setTimeout(() => {
      setError(latest.current.t('pchatTimeout'));
    }, 8 * 60_000);
    return () => window.clearTimeout(timer);
  }, [requestId, running]);

  const send = async (text: string): Promise<boolean> => {
    if (mutation.current || isRequestActive(active.current) || !loaded) return false;
    mutation.current = true;
    const epoch = generation.current;
    const optimistic: PerimeterMessage = { id: -Date.now(), role: 'user', content: text, createdAt: new Date().toISOString(), meta: null };
    setSending(true);
    setError(null);
    setNotice(null);
    setRequest(null);
    setMessages((previous) => [...previous, optimistic]);
    const { submission } = preparePendingSubmission(pending.current, text, thread.current, () => crypto.randomUUID());
    pending.current = submission;
    try {
      const accepted = await submitWithAmbiguousRetry(() => webApi.map.ask(text, csrfToken, latest.current.context, submission.idempotencyKey));
      if (!mounted.current || generation.current !== epoch) return true;
      pending.current = null;
      setRequest(accepted.request);
      // enqueue persisted the question; the normal snapshot reconciles its id.
      refresh();
      return true;
    } catch (cause) {
      if (!isAmbiguousApiRequestError(cause)) pending.current = null;
      if (mounted.current && generation.current === epoch) {
        setError(cause instanceof Error ? cause.message : latest.current.t('requestFailed'));
        setMessages((previous) => previous.filter((message) => message.id !== optimistic.id));
      }
      return false;
    } finally {
      mutation.current = false;
      if (mounted.current) setSending(false);
    }
  };

  const reset = async () => {
    if (mutation.current) return;
    mutation.current = true;
    generation.current++;
    gate.current.invalidate();
    setResetting(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await webApi.map.resetChat(csrfToken);
      if (!mounted.current) return;
      gate.current.invalidate();
      thread.current = payload.threadId;
      pending.current = null;
      setMessages(mergeAdvisoryMessages(payload.messages,
        latest.current.advisories.filter((entry) => entry.threadId === payload.threadId).map((entry) => entry.message), 0));
      setRequest(null);
      setLoaded(true);
      setNotice(latest.current.t('pchatCleared'));
    } catch {
      if (mounted.current) setError(latest.current.t('pchatResetError'));
      // A lost POST response may still mean the server reset successfully.
      refresh();
    } finally {
      mutation.current = false;
      if (mounted.current) setResetting(false);
    }
  };

  return { messages, request, sending, resetting, loaded, error, notice, send, reset, refresh, onSnapshot, onDelta, onPollError };
}
