import { memo, useEffect, useRef, useState } from 'react';
import { AlertIcon, ArrowDownIcon, CloseIcon, MarketIcon, MenuIcon, RouteIcon, SendIcon, TargetIcon } from '../icons';
import type { ActivityStep, ChatMessage, WebAgentRequest } from '../types';
import { decideScrollBehavior, isPinnedToBottom, scrollToBottom } from '../chat-scroll';
import { LocaleSwitch, useI18n } from '../i18n';
import { parseSqlUtcDate, parseSqlUtcMs } from '../sql-utc';
import { MarkdownMessage } from './MarkdownMessage';

const MAX_MESSAGE_LENGTH = 2000;
const COUNTER_VISIBLE_FROM = 1600;

type ChatScreenProps = {
  title: string;
  conversationId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  request: WebAgentRequest | null;
  error: string | null;
  modelLabel: string | null;
  portraitUrl: string | null;
  pilotInitial: string;
  dockOpen: boolean;
  onMenu: () => void;
  onSend: (message: string) => Promise<void>;
  onCancel: () => void;
  onDismissError: () => void;
  onToggleDock: () => void;
  /** Chip click / "open in the dock": routes a tool payload into the data dock. */
  onInspectTools: (steps: ActivityStep[]) => void;
  /** Seeds the composer once (e.g. "try in chat" from the examples screen). */
  initialDraft?: string | null;
  onInitialDraftConsumed?: () => void;
};

export function ChatScreen({
  title, conversationId, messages, busy, request, error, modelLabel, portraitUrl, pilotInitial, dockOpen,
  onMenu, onSend, onCancel, onDismissError, onToggleDock, onInspectTools, initialDraft, onInitialDraftConsumed,
}: ChatScreenProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  // Deliberately keyed to initialDraft alone: the consume callback identity
  // must not re-run the seeding.
  useEffect(() => {
    if (!initialDraft) return;
    setDraft(initialDraft);
    onInitialDraftConsumed?.();
    composerRef.current?.focus();
  }, [initialDraft]);

  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // После смены разговора первая прокрутка к свежей истории — мгновенная.
  // App держит сообщения предыдущего разговора до загрузки новых, поэтому
  // мгновенная прокрутка откладывается, пока на экране старые сообщения.
  const initialScroll = useRef({
    conversationId,
    firstMessageId: (messages[0]?.id ?? null) as ChatMessage['id'] | null,
    done: false,
  });
  if (initialScroll.current.conversationId !== conversationId) {
    initialScroll.current = {
      conversationId,
      firstMessageId: messages[0]?.id ?? null,
      done: false,
    };
  }
  const suggestions = [
    { text: t('suggestionRoute'), Icon: RouteIcon },
    { text: t('suggestionMarket'), Icon: MarketIcon },
    { text: t('suggestionLosses'), Icon: TargetIcon },
  ];
  const progressSequence = request?.progressSequence ?? 0;
  const streamText = request && (request.status === 'queued' || request.status === 'running')
    ? request.streamText
    : '';

  useEffect(() => {
    setPinnedToBottom(true);
  }, [conversationId]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!pinnedToBottom || !container) return;
    const state = initialScroll.current;
    if (!state.done) {
      const firstMessageId = messages[0]?.id ?? null;
      // На экране ещё история предыдущего разговора — ждём свежую.
      if (messages.length > 0 && firstMessageId === state.firstMessageId) return;
      scrollToBottom(container, decideScrollBehavior(true));
      state.done = true;
      return;
    }
    scrollToBottom(container, decideScrollBehavior(false));
  }, [conversationId, messages, busy, progressSequence, streamText.length, pinnedToBottom]);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    setPinnedToBottom(isPinnedToBottom(container));
  };

  const scrollToLatest = () => {
    const container = scrollRef.current;
    setPinnedToBottom(true);
    if (container) scrollToBottom(container, 'smooth');
  };

  const resizeComposer = () => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
  };

  const submit = async (value = draft) => {
    const message = value.trim();
    if (!message || busy) return;
    setDraft('');
    window.requestAnimationFrame(() => {
      resizeComposer();
      composerRef.current?.focus();
    });
    await onSend(message);
  };

  const thread = (
    <div className="message-thread" role="log" aria-busy={busy}>
      {messages.map((message) => <MessageBubble
        key={message.id}
        message={message}
        portraitUrl={portraitUrl}
        pilotInitial={pilotInitial}
        onInspectTools={onInspectTools}
      />)}
      {busy ? <LiveTurn request={request} streamText={streamText} onCancel={onCancel} /> : null}
    </div>
  );

  const showIntro = messages.length === 0 && !busy && !streamText;

  return <section className="chat-canvas">
    <header className="chat-header">
      <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon size={20} /></button>
      <div className="chat-header__copy">
        <span className="chat-header__kicker">{t('threadKicker')}</span>
        <h1>{title}</h1>
      </div>
      <div className="chat-header__actions">
        {modelLabel ? <span className="model-pill">{modelLabel}</span> : null}
        <LocaleSwitch />
        <button className="icon-button" type="button" onClick={onToggleDock} aria-pressed={dockOpen} aria-label={dockOpen ? t('dockClose') : t('dockOpen')}><MarketIcon size={20} /></button>
      </div>
    </header>
    <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll} aria-live="polite">
      {showIntro ? <section className="chat-intro"><div className="chat-intro__orbit" aria-hidden="true" /><h2>{t('introTitle')}</h2><p>{t('introLead')}</p><div className="suggestions">{suggestions.map(({ text, Icon }) => <button type="button" key={text} onClick={() => void submit(text)} disabled={busy}><Icon size={20} /><span>{text}</span></button>)}</div></section> : null}
      {messages.length > 0 || busy ? thread : null}
    </div>
    <div className="composer-region">
      {pinnedToBottom ? null : <button className="scroll-latest" type="button" onClick={scrollToLatest} aria-label={t('scrollToLatest')}><ArrowDownIcon size={16} /><span>{t('scrollToLatest')}</span></button>}
      {error ? <div className="composer-error" role="alert"><AlertIcon size={15} /><span>{error}</span><button className="composer-error__dismiss" type="button" onClick={onDismissError} aria-label={t('dismissError')}><CloseIcon size={14} /></button></div> : null}
      <div className="composer">
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); resizeComposer(); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }}
          placeholder={t('placeholder')}
          aria-label={t('message')}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          enterKeyHint="send"
        />
        <button className="send-button" type="button" onClick={() => void submit()} disabled={!draft.trim() || busy} aria-label={t('send')}><SendIcon size={20} /></button>
      </div>
      <div className="composer-meta">
        <span className="composer-meta__hint">{t('composerHintSend')}</span>
        <span className="composer-meta__hint">{t('composerHintNewline')}</span>
        {draft.length >= COUNTER_VISIBLE_FROM ? <span className="composer-meta__counter">{draft.length} / {MAX_MESSAGE_LENGTH}</span> : null}
      </div>
    </div>
  </section>;
}

type BubbleProps = {
  message: ChatMessage;
  portraitUrl: string | null;
  pilotInitial: string;
  onInspectTools: (steps: ActivityStep[]) => void;
};

const MessageBubble = memo(function MessageBubble({ message, portraitUrl, pilotInitial, onInspectTools }: BubbleProps) {
  const { locale } = useI18n();
  const isUser = message.role === 'user';
  const timestamp = formatMessageTime(message.created_at, locale);
  if (isUser) {
    return <article className="message message--user">
      <div className="message__body">
        <div className="message__content"><MarkdownMessage content={message.content} /></div>
        {timestamp ? <time className="message__time" dateTime={timestamp.iso}>{timestamp.label}</time> : null}
      </div>
      <span className="pilot-mark" aria-hidden="true">{portraitUrl ? <img src={portraitUrl} alt="" /> : pilotInitial}</span>
    </article>;
  }
  return <article className="message message--assistant">
    <span className="assistant-mark" aria-hidden="true" />
    <div className="message__body">
      {message.activity?.length ? <ToolChips steps={message.activity} onInspect={onInspectTools} /> : null}
      <div className="message__content"><MarkdownMessage content={message.content} /></div>
      {timestamp ? <time className="message__time" dateTime={timestamp.iso}>{timestamp.label}</time> : null}
    </div>
  </article>;
});

/**
 * Инструментарий агента вынесен из скрытого <details> в видимую строку чипов:
 * что он трогал, видно до того, как читаешь ответ. Клик по чипу открывает
 * сырой результат этого инструмента в доке.
 */
function ToolChips({ steps, onInspect }: { steps: ActivityStep[]; onInspect: (steps: ActivityStep[]) => void }) {
  const { t } = useI18n();
  return <div className="tool-chips">
    {steps.map((step, index) => <button
      className="tool-chip"
      type="button"
      key={`${step.name}-${index}`}
      title={t('toolChipOpen')}
      onClick={() => onInspect(steps)}
    >
      {step.name}
      {step.detail ? <span className="tool-chip__detail">· {step.detail}</span> : null}
    </button>)}
    <span className="tool-chips__total">{steps.length}</span>
  </div>;
}

function formatMessageTime(value: string, locale: 'ru' | 'en'): { iso: string; label: string } | null {
  const date = parseSqlUtcDate(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    label: date.toLocaleTimeString(locale === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' }),
  };
}

/**
 * Живой ход: пока текста нет — одна пилюля ожидания; как только приходит
 * streamText, над ней появляется панель ответа с кареткой в 1 знакоместо.
 * Таймер тикает раз в секунду от createdAt, разобранного как UTC.
 */
function LiveTurn({ request, streamText, onCancel }: { request: WebAgentRequest | null; streamText: string; onCancel: () => void }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  // createdAt приходит из SQLite в UTC без метки зоны — Date.parse прочёл бы
  // его как локальное время и таймер стартовал бы с оффсета пояса (180:00 у MSK).
  const createdAt = request ? parseSqlUtcMs(request.createdAt) : Number.NaN;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const queued = !request || request.status === 'queued';
  const latestStep = request?.activity.length ? request.activity[request.activity.length - 1] : null;
  const elapsed = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0;

  return <article className="message message--assistant" aria-label={t('thinking')}>
    <span className="assistant-mark" aria-hidden="true" />
    <div className="message__body">
      {streamText ? <div className="message__content" aria-live="polite" aria-atomic="false" aria-label={t('agentComposing')}>
        <MarkdownMessage content={streamText} />
        <span className="stream-cursor" aria-hidden="true" />
      </div> : null}
      <div className="thinking-pill thinking-pill--inline" role="status">
        <span className="thinking-pill__dot" aria-hidden="true" />
        <span className="thinking-pill__label">{queued ? t('requestQueued') : t('requestRunning')}</span>
        {latestStep ? <span className="thinking-pill__tool">{latestStep.name}</span> : null}
        <time className="thinking-pill__elapsed">{formatElapsed(elapsed)}</time>
        <button className="thinking-cancel" type="button" onClick={onCancel}>{t('cancelRequest')}</button>
      </div>
    </div>
  </article>;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
