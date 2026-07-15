import { useCallback, useEffect, useRef, useState } from 'react';
import { webApi } from './api';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar } from './components/Sidebar';
import { ChatScreen } from './components/ChatScreen';
import type { ChatMessage, Conversation, SessionPayload } from './types';

function authResultMessage(): string | null {
  const result = new URLSearchParams(window.location.search).get('auth');
  if (result === 'denied') return 'Вход через EVE отменён.';
  if (result === 'error') return 'Не удалось подключить персонажа. Попробуйте ещё раз.';
  return null;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<SessionPayload | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(authResultMessage);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  const messageLoadGeneration = useRef(0);

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

  useEffect(() => {
    let cancelled = false;
    void webApi.getSession()
      .then(async (payload) => {
        if (cancelled) return;
        setBootstrap(payload);
        if (payload.session) await loadConversations();
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Не удалось открыть приложение.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    if (window.location.search) window.history.replaceState({}, '', '/app');
    return () => { cancelled = true; };
  }, [loadConversations]);

  const ensureSession = async (): Promise<NonNullable<SessionPayload['session']>> => {
    if (session) return session;
    const payload = await webApi.createSession();
    setBootstrap(payload);
    if (!payload.session) throw new Error('Сервер не создал браузерную сессию.');
    return payload.session;
  };

  const connectEve = async () => {
    setBusy(true);
    setError(null);
    try {
      const activeSession = await ensureSession();
      const { url } = await webApi.startEveLogin(activeSession.csrfToken);
      window.location.assign(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось начать вход через EVE.');
      setBusy(false);
    }
  };

  const continueAsGuest = async () => {
    setBusy(true);
    setError(null);
    try {
      await ensureSession();
      await loadConversations();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось открыть гостевой режим.');
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
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setBusy(true);
    setError(null);
    try {
      const response = await webApi.sendMessage(content, sourceThreadId, session.csrfToken);
      const assistant: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.message,
        created_at: new Date().toISOString(),
        activity: response.activity,
      };
      if (activeIdRef.current === sourceThreadId) {
        setMessages((current) => [...current, assistant]);
        setActiveConversation(response.threadId);
      }
      await refreshConversationList();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Модель не ответила. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
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
        runtime: bootstrap?.runtime ?? {
          providerId: 'openai',
          providerName: 'Provider',
          model: 'unknown',
          reasoningEffort: 'auto',
        },
      });
      setConversations([]);
      setMessages([]);
      messageLoadGeneration.current += 1;
      setActiveConversation(null);
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
        error={error}
        onConnect={() => void connectEve()}
        onGuest={() => void continueAsGuest()}
      />
    );
  }

  const activeTitle = conversations.find((item) => item.id === activeId)?.title ?? 'Новый диалог';
  return (
    <main className="chat-app">
      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        activeId={activeId}
        busy={busy}
        character={session.character}
        onClose={() => setSidebarOpen(false)}
        onNew={() => void createConversation()}
        onSelect={(id) => void selectConversation(id)}
        onConnect={() => void connectEve()}
        onLogout={() => void logout()}
      />
      <ChatScreen
        title={activeTitle}
        messages={messages}
        busy={busy}
        error={error}
        runtime={bootstrap?.runtime ?? {
          providerId: 'openai',
          providerName: 'Provider',
          model: 'unknown',
          reasoningEffort: 'auto',
        }}
        onMenu={() => setSidebarOpen(true)}
        onSend={sendMessage}
      />
    </main>
  );
}
