import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AlertIcon, ArrowDownIcon, CheckIcon, CloseIcon, CompassMark, MarketIcon, MenuIcon, RouteIcon, SendIcon, TargetIcon } from '../icons';
import type { ChatMessage, WebAgentRequest } from '../types';
import { decideScrollBehavior, isPinnedToBottom, scrollToBottom } from '../chat-scroll';
import { LocaleSwitch, useI18n } from '../i18n';
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
  onMenu: () => void;
  onSend: (message: string) => Promise<void>;
  onCancel: () => void;
  onDismissError: () => void;
  /** Seeds the composer once (e.g. "try in chat" from the examples screen). */
  initialDraft?: string | null;
  onInitialDraftConsumed?: () => void;
};

export function ChatScreen({ title, conversationId, messages, busy, request, error, onMenu, onSend, onCancel, onDismissError, initialDraft, onInitialDraftConsumed }: ChatScreenProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (initialDraft) {
      setDraft(initialDraft);
      onInitialDraftConsumed?.();
      composerRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const routeImage = `${import.meta.env.BASE_URL}assets/orbit-route.png`;
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
      {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
      {busy ? (streamText
        ? <StreamingMessage text={streamText} onCancel={onCancel} />
        : <ThinkingMessage request={request} onCancel={onCancel} />) : null}
    </div>
  );

  const showIntro = messages.length === 0 && !busy && !streamText;

  return <section className="chat-canvas" style={{ '--chat-route-image': `url(${routeImage})` } as CSSProperties}>
    <header className="chat-header"><button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button><h1>{title}</h1><div className="chat-header__actions"><LocaleSwitch /></div></header>
    <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll} aria-live="polite">
      {showIntro ? <section className="chat-intro"><div className="chat-intro__orbit" aria-hidden="true" /><h2>{t('introTitle')}</h2><p>{t('introLead')}</p><div className="suggestions">{suggestions.map(({ text, Icon }) => <button type="button" key={text} onClick={() => void submit(text)} disabled={busy}><Icon size={23} /><span>{text}</span></button>)}</div></section> : null}
      {messages.length > 0 || busy ? thread : null}
    </div>
    {pinnedToBottom ? null : <button className="scroll-latest" type="button" onClick={scrollToLatest} aria-label={t('scrollToLatest')}><ArrowDownIcon size={18} /><span>{t('scrollToLatest')}</span></button>}
    <div className="composer-region">
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
        <button className="send-button" type="button" onClick={() => void submit()} disabled={!draft.trim() || busy} aria-label={t('send')}><SendIcon size={25} /></button>
      </div>
      <div className="composer-meta">
        <span className="composer-meta__hint">{t('composerHint')}</span>
        {draft.length >= COUNTER_VISIBLE_FROM ? <span className="composer-meta__counter">{draft.length}/{MAX_MESSAGE_LENGTH}</span> : null}
      </div>
    </div>
  </section>;
}

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const { t, locale } = useI18n();
  const isUser = message.role === 'user';
  const timestamp = formatMessageTime(message.created_at, locale);
  return <article className={`message message--${message.role}`}>{!isUser ? <div className="assistant-mark"><CompassMark size={24} /></div> : null}<div className="message__body"><div className="message__content"><MarkdownMessage content={message.content} /></div>{message.activity?.length ? <details className="activity-trace"><summary>{t('checkedSources')}: {message.activity.length}</summary><div className="activity-trace__steps">{message.activity.map((step, index) => <div key={`${step.name}-${index}`}><CheckIcon size={18} /><span>{humanizeToolName(step.name)}</span><small>{step.detail || t('completed')}</small></div>)}</div></details> : null}{timestamp ? <time className="message__time" dateTime={timestamp.iso}>{timestamp.label}</time> : null}</div></article>;
});

function formatMessageTime(value: string, locale: 'ru' | 'en'): { iso: string; label: string } | null {
  // SQLite хранит datetime('now') как «YYYY-MM-DD HH:MM:SS» в UTC.
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    label: date.toLocaleTimeString(locale === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' }),
  };
}

function StreamingMessage({ text, onCancel }: { text: string; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <article className="message message--assistant message--streaming">
      <div className="assistant-mark"><CompassMark size={24} /></div>
      <div className="message__body">
        <div className="message__content" aria-live="polite" aria-atomic="false" aria-label={t('agentComposing')}>
          <MarkdownMessage content={text} />
          <span className="stream-cursor" aria-hidden="true" />
        </div>
        <button className="thinking-cancel" type="button" onClick={onCancel}>{t('cancelRequest')}</button>
      </div>
    </article>
  );
}

function ThinkingMessage({ request, onCancel }: { request: WebAgentRequest | null; onCancel: () => void }) {  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const createdAt = request ? Date.parse(request.createdAt) : Number.NaN;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const queued = !request || request.status === 'queued';
  const latestStep = request?.activity.length ? request.activity[request.activity.length - 1] : null;
  const elapsed = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0;

  return (
    <article className="message message--assistant message--thinking">
      <div className="assistant-mark"><CompassMark size={24} /></div>
      <div className="thinking-body" role="status" aria-label={t('thinking')}>
        <div className="thinking-body__status">
          <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
          <strong>{queued ? t('requestQueued') : t('requestRunning')}</strong>
          <time>{formatElapsed(elapsed)}</time>
        </div>
        {latestStep ? <div className="thinking-body__step"><span>{humanizeToolName(latestStep.name)}</span><small>{t('toolCalls')}: {request?.activity.length ?? 0}</small></div> : null}
        <button className="thinking-cancel" type="button" onClick={onCancel}>{t('cancelRequest')}</button>
      </div>
    </article>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function humanizeToolName(name: string) { return name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
