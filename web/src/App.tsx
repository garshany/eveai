import { useCallback, useEffect, useRef, useState } from 'react';
import { isAmbiguousApiRequestError, webApi } from './api';
import {
  applyThreadDelta,
  applyThreadSnapshot,
  isRequestActive,
  preparePendingSubmission,
  submitWithAmbiguousRetry,
  trackThreadRequest,
  untrackThreadRequest,
  type PendingSubmission,
  type RequestsByThread,
  type StreamDeltaFrame,
} from './agent-request-client';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar, type AppView } from './components/Sidebar';
import { ChatScreen } from './components/ChatScreen';
import { DataDock, type DockTab } from './components/DataDock';
import { ExamplesScreen } from './components/ExamplesScreen';
import { MapScreen } from './components/map/MapScreen';
import { MarketScreen } from './components/MarketScreen';
import { PilotProfileScreen } from './components/PilotProfileScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { SupportScreen } from './components/SupportScreen';
import { clearMarketStaticCache } from './components/market/static-cache';
import { useI18n } from './i18n';
import type {
  ActivityStep,
  ChatMessage,
  Conversation,
  MarketSnapshotMeta,
  PilotProfile,
  SessionPayload,
  WebAgentRequest,
} from './types';

/**
 * Результат последнего опроса `/api/web/market/status`. Отличать «снапшот не
 * приехал» от «снапшот свежий» обязательно: без флага провал опроса выглядел
 * бы в статус-пилюле как последнее удачное, сколь угодно старое, значение.
 */
export type SnapshotProbe = { ok: boolean; meta: MarketSnapshotMeta | null };

const DOCK_STORAGE_KEY = 'eveai.dock.v1';
/** Ниже этой ширины док не помещается рядом с тредом и живёт листом. */
const DOCK_DESKTOP_WIDTH = 1180;
/** Снапшот рынка обновляется раз в минуту — статус-пилюля не должна врать. */
const SNAPSHOT_POLL_MS = 60_000;
/** Живые поля пилота (локация, корабль, кошелёк) в ESI кэшируются 5–120 с. */
const PROFILE_POLL_MS = 60_000;

function authResultMessage(): string | null {
  const result = new URLSearchParams(window.location.search).get('auth');
  if (result === 'denied') return 'Вход через EVE отменён.';
  if (result === 'error') return 'Не удалось подключить персонажа. Попробуйте ещё раз.';
  return null;
}

/** По умолчанию док открыт только там, где для него есть колонка. */
function initialDockOpen(): boolean {
  const stored = localStorage.getItem(DOCK_STORAGE_KEY);
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  return window.matchMedia(`(min-width: ${DOCK_DESKTOP_WIDTH}px)`).matches;
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
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>('chat');
  // Agent turns in flight, one per thread: a reply streaming in one chat
  // must not lock the sidebar or the other chats. `busy` covers only short
  // UI actions (sending, switching pilot, logout).
  const [requests, setRequests] = useState<RequestsByThread>({});
  const [dockOpen, setDockOpen] = useState(initialDockOpen);
  const [dockTab, setDockTab] = useState<DockTab>('market');
  const [dockTrace, setDockTrace] = useState<ActivityStep[] | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotProbe | null>(null);
  const [profile, setProfile] = useState<PilotProfile | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const messageLoadGeneration = useRef(0);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);

  const session = bootstrap?.session ?? null;
  const activeRequest = activeId ? requests[activeId] ?? null : null;

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

  // Re-attaches to a reply still running after a reload. It is tracked for its
  // own thread without jumping there: the pilot stays in the chat they opened.
  const recoverActiveRequest = useCallback(async (threadId?: string | null) => {
    const result = await webApi.getActiveAgentRequest(threadId);
    const request = result.request;
    if (!request || !isRequestActive(request)) return;
    setRequests((current) => trackThreadRequest(current, request));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void webApi.getSession()
      .then(async (payload) => {
        if (cancelled) return;
        setBootstrap(payload);
        if (payload.session) {
          await loadConversations();
          await recoverActiveRequest(activeIdRef.current);
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

  const sessionActive = Boolean(session);
  const characterId = session?.character?.id ?? null;

  // Статус-пилюля сайдбара и док читают один и тот же снапшот: опрос живёт
  // здесь, а не в двух компонентах, и гасится вместе с сессией.
  useEffect(() => {
    if (!sessionActive) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void webApi.market.status()
        .then((payload) => { if (!cancelled) setSnapshot({ ok: true, meta: payload.snapshot }); })
        // Провалившийся опрос обнуляет снапшот, а не оставляет предыдущий:
        // иначе пилюля светилась бы зелёным «маркет 2 мин» весь простой API.
        .catch(() => { if (!cancelled) setSnapshot({ ok: false, meta: null }); });
    };
    load();
    const timer = window.setInterval(load, SNAPSHOT_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionActive]);

  // Карточка пилота (сайдбар, шапка, док) живёт на одном снапшоте профиля.
  // Он перечитывается раз в минуту при видимой вкладке, при возврате на
  // вкладку и после каждого ответа агента; сбой опроса оставляет последний
  // удачный снапшот, а не гасит карточку до смены персонажа.
  const profileCharacterRef = useRef<number | null>(null);
  const loadProfile = useCallback(async () => {
    const requestedFor = profileCharacterRef.current;
    if (requestedFor === null) return;
    try {
      const payload = await webApi.getProfile();
      if (profileCharacterRef.current === requestedFor && payload.profile?.character.id === requestedFor) {
        setProfile(payload.profile);
      }
    } catch {
      // Keep the last good profile; the next poll retries.
    }
  }, []);
  useEffect(() => {
    profileCharacterRef.current = characterId;
    setProfile(null);
    if (characterId === null) return;
    void loadProfile();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadProfile();
    }, PROFILE_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void loadProfile(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [characterId, loadProfile]);

  // Пилюля модели перечитывается при каждом возврате в чат: «Настройки» —
  // отдельный экран, и после сохранения шапка иначе показывала бы модель,
  // выбранную на входе, пока запросы уже идут по новой.
  useEffect(() => {
    if (!sessionActive || activeView !== 'chat') return;
    let cancelled = false;
    void webApi.getModelSettings()
      .then((payload) => {
        if (cancelled) return;
        const { model, reasoningEffort } = payload.settings;
        setModelLabel(reasoningEffort === 'auto' ? model : `${model} · ${reasoningEffort}`);
      })
      .catch(() => { /* пилюля модели просто не появится */ });
    return () => { cancelled = true; };
  }, [sessionActive, activeView]);

  // Док показывает инструментарий последнего ответа ЭТОГО треда — и только
  // его. Пустую активность обязательно записываем как null: иначе при смене
  // треда (и после перелогина в той же вкладке) в доке остался бы разбор
  // чужого разговора.
  useEffect(() => {
    const lastAssistant = findLastAssistantIndex(messages);
    const activity = lastAssistant >= 0 ? messages[lastAssistant]?.activity ?? null : null;
    setDockTrace(activity?.length ? activity : null);
  }, [messages, activeId]);

  const toggleDock = useCallback(() => {
    setDockOpen((current) => {
      const next = !current;
      localStorage.setItem(DOCK_STORAGE_KEY, next ? 'open' : 'closed');
      return next;
    });
  }, []);

  const openDock = useCallback((tab: DockTab) => {
    setDockTab(tab);
    setDockOpen(true);
    localStorage.setItem(DOCK_STORAGE_KEY, 'open');
  }, []);

  const onRequestSnapshot = useCallback((request: WebAgentRequest) => {
    setRequests((current) => applyThreadSnapshot(current, request));
  }, []);
  const onRequestDelta = useCallback((threadId: string, frame: StreamDeltaFrame) => {
    setRequests((current) => applyThreadDelta(current, threadId, frame));
  }, []);
  const onRequestPollError = useCallback((message: string) => setError(message), []);

  // A finished turn refreshes its thread (only if it is on screen) and the
  // list, then stops being tracked. Each request id is finalized once.
  const finalizingRef = useRef(new Set<string>());
  useEffect(() => {
    for (const request of Object.values(requests)) {
      if (isRequestActive(request) || finalizingRef.current.has(request.requestId)) continue;
      finalizingRef.current.add(request.requestId);
      void (async () => {
        try {
          const result = await webApi.getMessages(request.threadId);
          if (activeIdRef.current === request.threadId) {
            if (request.status === 'completed') {
              const lastAssistant = findLastAssistantIndex(result.messages);
              setMessages(result.messages.map((message, index) => index === lastAssistant
                ? { ...message, activity: request.activity }
                : message));
            } else {
              setMessages(result.messages);
            }
          }
          await refreshConversationList();
          // Агент мог сменить корабль/фит или потратить ISK — карточка догоняет.
          void loadProfile();
          if (request.status !== 'completed') {
            setError(request.error ?? 'Не удалось завершить запрос.');
          }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Не удалось обновить диалог.');
        } finally {
          finalizingRef.current.delete(request.requestId);
          setRequests((current) => untrackThreadRequest(current, request.threadId, request.requestId));
        }
      })();
    }
  }, [requests, refreshConversationList, loadProfile]);

  const ensureSession = async (turnstileToken?: string): Promise<NonNullable<SessionPayload['session']>> => {
    if (session) return session;
    const payload = await webApi.createSession(turnstileToken);
    setBootstrap(payload);
    if (!payload.session) throw new Error('Сервер не создал браузерную сессию.');
    return payload.session;
  };

  const connectEve = async (turnstileToken?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const activeSession = await ensureSession(turnstileToken);
      const { url } = await webApi.startEveLogin(activeSession.csrfToken, locale);
      window.location.assign(url);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось начать вход через EVE.');
      setBusy(false);
      return false;
    }
  };

  const continueAsGuest = async (turnstileToken?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await ensureSession(turnstileToken);
      await loadConversations();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось открыть гостевой режим.');
      return false;
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

  // Ошибки не проглатываем: профиль показывает текст сервера из ApiRequestError.
  const unlinkCharacter = async (characterId: number) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await webApi.unlinkCharacter(characterId, session.csrfToken);
      const payload = await webApi.getSession();
      setBootstrap(payload);
      await loadConversations();
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
      await recoverActiveRequest(threadId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить диалог.');
    }
  };

  const deleteConversation = async (threadId: string) => {
    if (!session) return;
    await webApi.deleteConversation(threadId, session.csrfToken);
    if (activeIdRef.current === threadId) {
      messageLoadGeneration.current += 1;
      setActiveConversation(null);
      setMessages([]);
    }
    await refreshConversationList();
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
      // A new chat gets its id from the server; follow it only if the pilot
      // is still where they sent from.
      if (activeIdRef.current === sourceThreadId) setActiveConversation(response.request.threadId);
      setRequests((current) => trackThreadRequest(current, response.request));
      await refreshConversationList();
    } catch (reason) {
      if (!isAmbiguousApiRequestError(reason)) pendingSubmissionRef.current = null;
      setError(reason instanceof Error ? reason.message : 'Модель не ответила. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  const cancelActiveRequest = async () => {
    if (!session || !activeRequest) return;
    try {
      const response = await webApi.cancelAgentRequest(activeRequest.requestId, session.csrfToken);
      setRequests((current) => applyThreadSnapshot(current, response.request));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось отменить запрос.');
    }
  };

  const logout = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await webApi.logout(session.csrfToken);
      // Статика SDE следующего пользователя запрашивается заново, а не
      // дочитывается из кэша вкладки прежнего сеанса.
      clearMarketStaticCache();
      setBootstrap({
        session: null,
        ssoConfigured: bootstrap?.ssoConfigured ?? false,
        turnstileSiteKey: bootstrap?.turnstileSiteKey ?? null,
      });
      setConversations([]);
      setMessages([]);
      setRequests({});
      pendingSubmissionRef.current = null;
      messageLoadGeneration.current += 1;
      setActiveConversation(null);
      setActiveView('chat');
      // Док переживает выход из сессии вместе со вкладкой — гасим его руками,
      // иначе следующий вошедший в этом браузере увидит чужой разбор.
      setDockTrace(null);
      setDockTab('market');
      setProfile(null);
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
    if (activeView === 'support') {
      return <SupportScreen hasSession={false} onBackToLogin={() => setActiveView('chat')} />;
    }
    return (
      <LoginScreen
        busy={busy}
        ssoConfigured={bootstrap?.ssoConfigured ?? false}
        turnstileSiteKey={bootstrap?.turnstileSiteKey ?? null}
        error={error}
        onConnect={connectEve}
        onGuest={continueAsGuest}
        onShowSupport={() => setActiveView('support')}
      />
    );
  }

  const activeTitle = conversations.find((item) => item.id === activeId)?.title ?? t('newChat');
  const inChat = activeView === 'chat';
  const dockVisible = inChat && dockOpen;
  const seedComposer = (question: string) => {
    setPendingDraft(question);
    setActiveView('chat');
    // На узких экранах док лежит поверх композера — освобождаем его.
    if (!window.matchMedia(`(min-width: ${DOCK_DESKTOP_WIDTH}px)`).matches) setDockOpen(false);
  };
  const mobileTabs: Array<{ id: 'chat' | DockTab; label: string; active: boolean; onSelect: () => void }> = [
    { id: 'chat', label: t('mobileTabChat'), active: !dockVisible, onSelect: () => { setActiveView('chat'); setDockOpen(false); } },
    { id: 'market', label: t('mobileTabMarket'), active: dockVisible && dockTab === 'market', onSelect: () => { setActiveView('chat'); openDock('market'); } },
    { id: 'pilot', label: t('mobileTabPilot'), active: dockVisible && dockTab === 'pilot', onSelect: () => { setActiveView('chat'); openDock('pilot'); } },
  ];

  return (
    <main className={`chat-app${dockVisible ? ' chat-app--docked' : ''}`}>
      {Object.values(requests).filter(isRequestActive).map((request) => <RequestObserver
        key={request.requestId}
        requestId={request.requestId}
        threadId={request.threadId}
        retryAfterMs={request.retryAfterMs ?? 1_000}
        onSnapshot={onRequestSnapshot}
        onDelta={onRequestDelta}
        onPollError={onRequestPollError}
      />)}
      <Sidebar
        open={sidebarOpen}
        activeView={activeView}
        conversations={conversations}
        activeId={activeId}
        busy={busy}
        character={session.character}
        characters={session.characters}
        snapshot={snapshot}
        portraitUrl={profile?.character.portraitUrl ?? null}
        skillPoints={profile?.skills?.totalSp ?? null}
        locationName={profile?.location?.solarSystemName ?? null}
        onClose={() => setSidebarOpen(false)}
        onView={(view) => { setActiveView(view); setSidebarOpen(false); }}
        onNew={() => { setActiveView('chat'); void createConversation(); }}
        onSelect={(id) => { setActiveView('chat'); void selectConversation(id); }}
        onDelete={deleteConversation}
        onConnect={() => void connectEve()}
        onActivate={(id) => void activateCharacter(id)}
        onLogout={() => void logout()}
      />
      {inChat ? <ChatScreen
        title={activeTitle}
        conversationId={activeId}
        messages={messages}
        busy={busy || isRequestActive(activeRequest)}
        request={activeRequest}
        error={error}
        modelLabel={modelLabel}
        portraitUrl={profile?.character.portraitUrl ?? null}
        pilotInitial={(session.character?.name ?? session.displayName).slice(0, 1).toUpperCase()}
        dockOpen={dockOpen}
        onMenu={() => setSidebarOpen(true)}
        onSend={sendMessage}
        onCancel={() => void cancelActiveRequest()}
        onDismissError={() => setError(null)}
        onToggleDock={toggleDock}
        onInspectTools={(steps) => { setDockTrace(steps); openDock('route'); }}
        initialDraft={pendingDraft}
        onInitialDraftConsumed={() => setPendingDraft(null)}
      /> : null}
      {activeView === 'market' ? <MarketScreen onMenu={() => setSidebarOpen(true)} csrfToken={session.csrfToken} /> : null}
      {activeView === 'map' ? <MapScreen onMenu={() => setSidebarOpen(true)} csrfToken={session.csrfToken} /> : null}
      {activeView === 'profile' ? <PilotProfileScreen character={session.character} csrfToken={session.csrfToken} busy={busy} onProfileLoaded={setProfile} onMenu={() => setSidebarOpen(true)} onConnect={() => void connectEve()} onUnlink={unlinkCharacter} /> : null}
      {activeView === 'settings' ? <SettingsScreen csrfToken={session.csrfToken} onMenu={() => setSidebarOpen(true)} /> : null}
      {activeView === 'examples' ? <ExamplesScreen onMenu={() => setSidebarOpen(true)} onTryInChat={seedComposer} /> : null}
      {activeView === 'support' ? <SupportScreen hasSession onMenu={() => setSidebarOpen(true)} /> : null}
      {dockVisible ? <DataDock
        tab={dockTab}
        trace={dockTrace}
        profile={profile}
        characterId={characterId}
        onTab={setDockTab}
        onClose={toggleDock}
        onAsk={seedComposer}
      /> : null}
      {inChat ? <nav className="mobile-tabs" aria-label={t('chat')}>
        {mobileTabs.map(({ id, label, active, onSelect }) => <button
          className={`mobile-tabs__tab${active ? ' mobile-tabs__tab--active' : ''}`}
          type="button"
          key={id}
          aria-current={active ? 'page' : undefined}
          onClick={onSelect}
        >{label}</button>)}
      </nav> : null}
    </main>
  );
}

function findLastAssistantIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index;
  }
  return -1;
}

type RequestObserverProps = {
  requestId: string;
  threadId: string;
  retryAfterMs: number;
  onSnapshot: (request: WebAgentRequest) => void;
  onDelta: (threadId: string, frame: StreamDeltaFrame) => void;
  onPollError: (message: string) => void;
};

/**
 * Follows one in-flight turn: the SSE stream pushes every snapshot and delta;
 * polling is only the fallback when the stream is unavailable. Rendered once
 * per active request, so several chats can stream at the same time.
 */
function RequestObserver({ requestId, threadId, retryAfterMs, onSnapshot, onDelta, onPollError }: RequestObserverProps) {
  const retryAfterRef = useRef(retryAfterMs);
  retryAfterRef.current = retryAfterMs;
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const applySnapshot = (request: WebAgentRequest) => {
      if (!cancelled) onSnapshot(request);
    };
    const startPolling = () => {
      if (cancelled || timer !== null) return;
      timer = window.setInterval(() => {
        void webApi.getAgentRequest(requestId)
          .then(({ request }) => applySnapshot(request))
          .catch((reason: unknown) => {
            if (!cancelled) onPollError(reason instanceof Error ? reason.message : 'Не удалось проверить состояние запроса.');
          });
      }, Math.max(500, retryAfterRef.current));
    };
    const source = typeof EventSource === 'undefined'
      ? null
      : new EventSource(`/api/web/chat/requests/${encodeURIComponent(requestId)}/events`);
    source?.addEventListener('request', (event) => {
      if (cancelled || !(event instanceof MessageEvent)) return;
      try {
        const payload = JSON.parse(event.data) as { request?: WebAgentRequest };
        if (payload.request?.requestId === requestId) applySnapshot(payload.request);
      } catch {
        // A malformed frame is skipped; the next snapshot carries full state.
      }
    });
    source?.addEventListener('delta', (event) => {
      if (cancelled || !(event instanceof MessageEvent)) return;
      try {
        const frame = JSON.parse(event.data) as StreamDeltaFrame;
        if (frame.requestId === requestId) onDelta(threadId, frame);
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
      source?.close();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [requestId, threadId, onSnapshot, onDelta, onPollError]);
  return null;
}
