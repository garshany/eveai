import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AlertIcon, ArrowDownIcon, CheckIcon, CloseIcon, CompassMark, MarketIcon, MenuIcon, PaperclipIcon, RouteIcon, SendIcon, TargetIcon } from '../icons';
import type { ChatMessage, WebAgentRequest } from '../types';
import { LocaleSwitch, useI18n } from '../i18n';
import { MarkdownMessage } from './MarkdownMessage';

const SCROLL_PIN_THRESHOLD_PX = 90;
const MAX_MESSAGE_LENGTH = 2000;
const COUNTER_VISIBLE_FROM = 1600;

type ChatScreenProps = {
  title: string;
  messages: ChatMessage[];
  busy: boolean;
  request: WebAgentRequest | null;
  error: string | null;
  onMenu: () => void;
  onSend: (message: string) => Promise<void>;
  onCancel: () => void;
  onDismissError: () => void;
};

export function ChatScreen({ title, messages, busy, request, error, onMenu, onSend, onCancel, onDismissError }: ChatScreenProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const routeImage = `${import.meta.env.BASE_URL}assets/orbit-route.png`;
  const suggestions = [
    { text: t('suggestionRoute'), Icon: RouteIcon },
    { text: t('suggestionMarket'), Icon: MarketIcon },
    { text: t('suggestionLosses'), Icon: TargetIcon },
  ];
  const progressSequence = request?.progressSequence ?? 0;

  useEffect(() => {
    if (pinnedToBottom) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy, progressSequence, pinnedToBottom]);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    setPinnedToBottom(distance < SCROLL_PIN_THRESHOLD_PX);
  };

  const scrollToLatest = () => {
    setPinnedToBottom(true);
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
      {busy ? <ThinkingMessage request={request} onCancel={onCancel} /> : null}
      <div ref={endRef} />
    </div>
  );

  return <section className="chat-canvas" style={{ '--chat-route-image': `url(${routeImage})` } as CSSProperties}>
    <header className="chat-header"><button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button><h1>{title}</h1><div className="chat-header__actions"><div className="connection-state" role="status"><span />{t('connected')}</div><LocaleSwitch /></div></header>
    <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll} aria-live="polite">
      <section className={`chat-intro${messages.length > 0 ? ' chat-intro--compact' : ''}`}><div className="chat-intro__orbit" aria-hidden="true" /><h2>{t('introTitle')}</h2><p>{t('introLead')}</p><div className="suggestions">{suggestions.map(({ text, Icon }) => <button type="button" key={text} onClick={() => void submit(text)} disabled={busy}><Icon size={23} /><span>{text}</span></button>)}</div></section>
      {messages.length > 0 || busy ? thread : null}
    </div>
    {pinnedToBottom ? null : <button className="scroll-latest" type="button" onClick={scrollToLatest} aria-label={t('scrollToLatest')}><ArrowDownIcon size={18} /><span>{t('scrollToLatest')}</span></button>}
    <div className="composer-region">
      {error ? <div className="composer-error" role="alert"><AlertIcon size={15} /><span>{error}</span><button className="composer-error__dismiss" type="button" onClick={onDismissError} aria-label={t('dismissError')}><CloseIcon size={14} /></button></div> : null}
      <div className="composer">
        <button className="icon-button composer__utility" type="button" aria-label={t('attachments')} disabled><PaperclipIcon size={24} /></button>
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
  const { t } = useI18n();
  const isUser = message.role === 'user';
  return <article className={`message message--${message.role}`}>{!isUser ? <div className="assistant-mark"><CompassMark size={24} /></div> : null}<div className="message__body"><div className="message__content"><MarkdownMessage content={message.content} /></div>{message.activity?.length ? <details className="activity-trace"><summary>{t('checkedSources')}: {message.activity.length}</summary><div className="activity-trace__steps">{message.activity.map((step, index) => <div key={`${step.name}-${index}`}><CheckIcon size={18} /><span>{humanizeToolName(step.name)}</span><small>{step.detail || t('completed')}</small></div>)}</div></details> : null}</div></article>;
});

function ThinkingMessage({ request, onCancel }: { request: WebAgentRequest | null; onCancel: () => void }) {
  const { t } = useI18n();
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
