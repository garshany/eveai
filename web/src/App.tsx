import { useCallback, useEffect, useRef, useState } from 'react';
import { isAmbiguousApiRequestError, webApi } from './api';
import {
  mergeRequestSnapshot,
  preparePendingSubmission,
  submitWithAmbiguousRetry,
  type PendingSubmission,
} from './agent-request-client';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar, type AppView } from './components/Sidebar';
import { ChatScreen } from './components/ChatScreen';
import { PilotProfileScreen } from './components/PilotProfileScreen';
import { LiveScanScreen } from './components/LiveScanScreen';
import { useI18n } from './i18n';
import type { ChatMessage, Conversation, SessionPayload, WebAgentRequest } from './types';

function authResultMessage(): string | null {
  const result = new URLSearchParams(window.location.search).get('auth');
  if (result === 'denied') return 'Вход через EVE отменён.';
  if (result === 'error') return 'Не удалось подключить персонажа. Попробуйте ещё раз.';
  return null;
}

export default function App() {
  const { locale, t } = useI18n();
  const [bootstrap, setBootstrap] = useState<SessionPayload | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(authResultMessage);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState<AppView>('chat');
  const [activeRequest, setActiveRequest] = useState<WebAgentRequest | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const messageLoadGeneration = useRef(0);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);

  const session = bootstrap?.session ?? null;

  const setActiveConversation = useCallback((threadId: string | null) => {
    activeIdRef.current = threadId;
    setActiveId(threadId);
  }, []);

  const refreshConversationList = useCallback(async () => {
    const result = await webApi.listConversations();
    setConversations(result.conversations);
    return result.conversations;
  }, []);

  const loadConversations = useCallback(async (preferredId?: string | null) => {
    const generation = ++messageLoadGeneration.current;
    const items = await refreshConversationList();
    const nextId = preferredId && items.some((item) => item.id === preferredId)
      ? preferredId
      : items[0]?.id ?? null;
    setActiveConversation(nextId);
    if (nextId) {
      const result = await webApi.getMessages(nextId);
      if (generation === messageLoadGeneration.current && activeIdRef.current === nextId) {
        setMessages(result.messages);
      }
    } else if (generation === messageLoadGeneration.current) {
      setMessages([]);
    }
  }, [refreshConversationList, setActiveConversation]);

  const recoverActiveRequest = useCallback(async () => {
    const result = await webApi.getActiveAgentRequest();
    if (!result.request) return;
    const generation = ++messageLoadGeneration.current;
    const messagesResult = await webApi.getMessages(result.request.threadId);
    if (generation !== messageLoadGeneration.current) return;
    setActiveConversation(result.request.threadId);
    setMessages(messagesResult.messages);
    setActiveRequest(result.request);
    setBusy(true);
  }, [setActiveConversation]);

  useEffect(() => {
    let cancelled = false;
    void webApi.getSession()
      .then(async (payload) => {
        if (cancelled) return;
        setBootstrap(payload);
        if (payload.session) {
          await loadConversations();
          await recoverActiveRequest();
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Не удалось открыть приложение.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    if (window.location.search) window.history.replaceState({}, '', '/app');
    return () => { cancelled = true; };
  }, [loadConversations, recoverActiveRequest]);

  const observedRequestId = activeRequest?.requestId ?? null;
  const observedRequestStatus = activeRequest?.status ?? null;
  const observedRetryAfterMs = activeRequest?.retryAfterMs ?? 1_000;

  useEffect(() => {
    if (!observedRequestId || (observedRequestStatus !== 'queued' && observedRequestStatus !== 'running')) return;
    let cancelled = false;
    const source = typeof EventSource === 'undefined'
      ? null
      : new EventSource(`/api/web/chat/requests/${encodeURIComponent(observedRequestId)}/events`);
    const applySnapshot = (request: WebAgentRequest) => {
      if (!cancelled) setActiveRequest((current) => mergeRequestSnapshot(current, request));
    };
    source?.addEventListener('request', (event) => {
      if (cancelled || !(event instanceof MessageEvent)) return;
      try {
        const payload = JSON.parse(event.data) as { request?: WebAgentRequest };
        if (payload.request?.requestId === observedRequestId) applySnapshot(payload.request);
      } catch {
        // Polling below remains authoritative when an SSE frame is malformed.
      }
    });
    source?.addEventListener('error', () => source.close());
    const timer = window.setInterval(() => {
      void webApi.getAgentRequest(observedRequestId)
        .then(({ request }) => applySnapshot(request))
        .catch((reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : 'Не удалось проверить состояние запроса.');
        });
    }, Math.max(500, observedRetryAfterMs));
    return () => {
      cancelled = true;
      source?.close();
      window.clearInterval(timer);
    };
  }, [observedRequestId, observedRequestStatus, observedRetryAfterMs]);

  useEffect(() => {
    if (!activeRequest || activeRequest.status === 'queued' || activeRequest.status === 'running') return;
    let cancelled = false;
    void (async () => {
      const result = await webApi.getMessages(activeRequest.threadId);
      if (!cancelled && activeIdRef.current === activeRequest.threadId) {
        if (activeRequest.status === 'completed') {
          const lastAssistant = findLastAssistantIndex(result.messages);
          setMessages(result.messages.map((message, index) => index === lastAssistant
            ? { ...message, activity: activeRequest.activity }
            : message));
        } else {
          setMessages(result.messages);
        }
      }
      await refreshConversationList();
      if (activeRequest.status !== 'completed' && !cancelled) {
        setError(activeRequest.error ?? 'Не удалось завершить запрос.');
      }
      if (!cancelled) {
        setBusy(false);
        setActiveRequest(null);
      }
    })().catch((reason: unknown) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : 'Не удалось обновить диалог.');
        setBusy(false);
        setActiveRequest(null);
      }
    });
    return () => { cancelled = true; };
  }, [activeRequest, refreshConversationList]);

  const ensureSession = async (turnstileToken?: string): Promise<NonNullable<SessionPayload['session']>> => {
    if (session) return session;
    const payload = await webApi.createSession(turnstileToken);
    setBootstrap(payload);
    if (!payload.session) throw new Error('Сервер не создал браузерную сессию.');
    return payload.session;
  };

  const connectEve = async (turnstileToken?: string) => {
    setBusy(true);
    setError(null);
    try {
      const activeSession = await ensureSession(turnstileToken);
      const { url } = await webApi.startEveLogin(activeSession.csrfToken, locale);
      window.location.assign(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось начать вход через EVE.');
      setBusy(false);
    }
  };

  const continueAsGuest = async (turnstileToken?: string) => {
    setBusy(true);
    setError(null);
    try {
      await ensureSession(turnstileToken);
      await loadConversations();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось открыть гостевой режим.');
    } finally {
      setBusy(false);
    }
  };

  const activateCharacter = async (characterId: number) => {
    if (!session || session.character?.id === characterId) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await webApi.activateCharacter(characterId, session.csrfToken);
      setBootstrap(payload);
      await loadConversations();
      setSidebarOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось переключить персонажа.');
    } finally {
      setBusy(false);
    }
  };

  const createConversation = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const created = await webApi.createConversation(session.csrfToken);
      await loadConversations(created.threadId);
      setSidebarOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось создать диалог.');
    } finally {
      setBusy(false);
    }
  };

  const selectConversation = async (threadId: string) => {
    const generation = ++messageLoadGeneration.current;
    setActiveConversation(threadId);
    setSidebarOpen(false);
    setError(null);
    try {
      const result = await webApi.getMessages(threadId);
      if (generation === messageLoadGeneration.current && activeIdRef.current === threadId) {
        setMessages(result.messages);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить диалог.');
    }
  };

  const sendMessage = async (content: string) => {
    if (!session) return;
    const sourceThreadId = activeIdRef.current;
    const { submission, retrying: retryingPendingSubmission } = preparePendingSubmission(
      pendingSubmissionRef.current,
      content,
      sourceThreadId,
      () => crypto.randomUUID(),
    );
    pendingSubmissionRef.current = submission;
    if (!retryingPendingSubmission) {
      const optimistic: ChatMessage = {
        id: `local-${Date.now()}`,
        role: 'user',
        content,
        created_at: new Date().toISOString(),
      };
      setMessages((current) => [...current, optimistic]);
    }
    setBusy(true);
    setError(null);
    try {
      const submit = () => webApi.sendMessage(
        submission.content,
        submission.threadId,
        submission.idempotencyKey,
        session.csrfToken,
      );
      const response = await submitWithAmbiguousRetry(submit);
      pendingSubmissionRef.current = null;
      setActiveConversation(response.request.threadId);
      setActiveRequest(response.request);
      await refreshConversationList();
    } catch (reason) {
      if (!isAmbiguousApiRequestError(reason)) pendingSubmissionRef.current = null;
      setError(reason instanceof Error ? reason.message : 'Модель не ответила. Попробуйте ещё раз.');
      setBusy(false);
    }
  };

  const cancelActiveRequest = async () => {
    if (!session || !activeRequest) return;
    try {
      const response = await webApi.cancelAgentRequest(activeRequest.requestId, session.csrfToken);
      setActiveRequest(response.request);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось отменить запрос.');
    }
  };

  const logout = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await webApi.logout(session.csrfToken);
      setBootstrap({
        session: null,
        ssoConfigured: bootstrap?.ssoConfigured ?? false,
        turnstileSiteKey: bootstrap?.turnstileSiteKey ?? null,
      });
      setConversations([]);
      setMessages([]);
      pendingSubmissionRef.current = null;
      messageLoadGeneration.current += 1;
      setActiveConversation(null);
      setActiveView('chat');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось завершить сессию.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="app-loading" aria-label="Загрузка"><span /><span /><span /></div>;
  }

  if (!session) {
    return (
      <LoginScreen
        busy={busy}
        ssoConfigured={bootstrap?.ssoConfigured ?? false}
        turnstileSiteKey={bootstrap?.turnstileSiteKey ?? null}
        error={error}
        onConnect={(token) => void connectEve(token)}
        onGuest={(token) => void continueAsGuest(token)}
      />
    );
  }

  const activeTitle = conversations.find((item) => item.id === activeId)?.title ?? t('newChat');
  return (
    <main className="chat-app">
      <Sidebar
        open={sidebarOpen}
        activeView={activeView}
        conversations={conversations}
        activeId={activeId}
        busy={busy}
        character={session.character}
        characters={session.characters}
        onClose={() => setSidebarOpen(false)}
        onView={(view) => { setActiveView(view); setSidebarOpen(false); }}
        onNew={() => { setActiveView('chat'); void createConversation(); }}
        onSelect={(id) => { setActiveView('chat'); void selectConversation(id); }}
        onConnect={() => void connectEve()}
        onActivate={(characterId) => void activateCharacter(characterId)}
        onLogout={() => void logout()}
      />
      {activeView === 'chat' ? <ChatScreen title={activeTitle} messages={messages} busy={busy} error={error} onMenu={() => setSidebarOpen(true)} onSend={sendMessage} onCancel={() => void cancelActiveRequest()} /> : null}
      {activeView === 'profile' ? <PilotProfileScreen character={session.character} onMenu={() => setSidebarOpen(true)} onConnect={() => void connectEve()} /> : null}
      {activeView === 'scan' ? <LiveScanScreen csrfToken={session.csrfToken} onMenu={() => setSidebarOpen(true)} onPrompt={(prompt) => { setActiveView('chat'); void sendMessage(prompt); }} /> : null}
    </main>
  );
}

function findLastAssistantIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index;
  }
  return -1;
}
