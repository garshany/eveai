import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { PerimeterMessage, WebAgentRequest } from '../../types';
import { isRequestActive } from '../../agent-request-client';
import { isPinnedToBottom, scrollToBottom } from '../../chat-scroll';
import { parseSqlUtcDate } from '../../sql-utc';
import { MarkdownMessage } from '../MarkdownMessage';
import { RequestObserver } from '../AgentRequestObserver';
import type { LiveAdvisory } from './use-map-live';
import { advisoryRuleKey } from './labels';
import { perimeterElapsedSeconds } from './perimeter-chat-state';
import { usePerimeterChat } from './use-perimeter-chat';
import './perimeter-chat.css';

export type MapAskContext = {
  systemId: number | null;
  selectedSystemId: number | null;
  shipTypeId: number | null;
  radius: number | null;
  band: string | null;
};
type Props = {
  csrfToken: string;
  advisories: LiveAdvisory[];
  context: MapAskContext;
  onFocusSystem: (systemId: number) => void;
};
export type SeverityFilter = 'all' | 'important' | 'quiet';
const SEVERITY_RANK = { info: 0, warn: 1, danger: 2 } as const;

export function PerimeterChat({ csrfToken, advisories, context, onFocusSystem }: Props) {
  const { t } = useI18n();
  const chat = usePerimeterChat(csrfToken, advisories, context);
  const [filter, setFilter] = useState<SeverityFilter>('all');
  // MapScreen can supply new callback/context objects on each live map tick.
  // Keep the expensive transcript independent of those parent renders.
  const focus = useRef(onFocusSystem);
  focus.current = onFocusSystem;
  const focusSystem = useCallback((id: number) => focus.current(id), []);
  const active = isRequestActive(chat.request);
  const busy = chat.sending || active;

  return <aside className="pchat-panel" aria-label={t('perimeterChat')}>
    {active && chat.request ? <RequestObserver
      requestId={chat.request.requestId} threadId={chat.request.threadId}
      retryAfterMs={chat.request.retryAfterMs}
      onSnapshot={chat.onSnapshot} onDelta={chat.onDelta} onPollError={chat.onPollError}
    /> : null}
    <header className="pchat-header">
      <div className="pchat-heading">
        <span className="pchat-title">{t('perimeterChat')}</span>
        <button className="pchat-button" type="button" disabled={chat.resetting || chat.sending}
          title={t('perimeterChatResetHint')} onClick={() => void chat.reset()}>
          {t(chat.resetting ? 'pchatClearing' : 'perimeterChatReset')}
        </button>
      </div>
      <div className="pchat-filters" role="group" aria-label={t('perimeterFilter')}>
        {(['all', 'important', 'quiet'] as const).map((value) => <button
          key={value} type="button" className="pchat-button" aria-pressed={filter === value}
          onClick={() => setFilter(value)}>
          {t(value === 'all' ? 'perimeterFilterAll' : value === 'important' ? 'perimeterFilterImportant' : 'perimeterFilterQuiet')}
        </button>)}
      </div>
    </header>
    <ChatFeed messages={chat.messages} filter={filter} onFocusSystem={focusSystem}
      streamText={active ? chat.request?.streamText ?? '' : ''} loaded={chat.loaded} />
    {busy ? <Waiting key={chat.request?.requestId ?? 'submitting'} request={chat.request} /> : null}
    {chat.notice ? <p className="pchat-notice" role="status">{chat.notice}</p> : null}
    {chat.error ? <div className="pchat-error" role="alert">{chat.error}
      <button type="button" className="pchat-button" onClick={chat.refresh}>{t('refresh')}</button>
    </div> : null}
    <Composer disabled={busy || chat.resetting || !chat.loaded} onSend={chat.send} />
  </aside>;
}

const ChatFeed = memo(function ChatFeed({ messages, filter, onFocusSystem, streamText, loaded }: {
  messages: PerimeterMessage[]; filter: SeverityFilter; onFocusSystem: (id: number) => void;
  streamText: string; loaded: boolean;
}) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const visible = useMemo(() => messages.filter((message) => !message.meta || filter === 'all'
    || SEVERITY_RANK[message.meta.severity] >= (filter === 'important' ? 1 : 2)), [messages, filter]);
  useEffect(() => {
    // One layout read/write per paint, only while the pilot follows the tail.
    if (!pinned.current) return;
    const frame = requestAnimationFrame(() => { if (list.current && pinned.current) scrollToBottom(list.current, 'instant'); });
    return () => cancelAnimationFrame(frame);
  }, [visible, streamText]);
  return <>
    <div className="pchat-feed" ref={list} role="log" aria-label={t('perimeterChat')}
      onScroll={() => {
        if (!list.current) return;
        pinned.current = isPinnedToBottom(list.current, 48);
        setShowLatest(!pinned.current);
      }}>
      {visible.length === 0 ? <p className="pchat-empty">{t(!loaded ? 'loading' : messages.length ? 'pchatFilteredEmpty' : 'perimeterChatEmpty')}</p> : null}
      {visible.map((message) => <ChatRow key={message.id} message={message} onFocusSystem={onFocusSystem} />)}
      {streamText ? <article className="pchat-row pchat-row--answer"><div className="pchat-markdown"><MarkdownMessage content={streamText} /></div></article> : null}
    </div>
    {showLatest ? <button className="pchat-latest pchat-button" type="button" onClick={() => {
      pinned.current = true;
      setShowLatest(false);
      if (list.current) scrollToBottom(list.current, 'instant');
    }}>{t('scrollToLatest')} ↓</button> : null}
  </>;
});

const ChatRow = memo(function ChatRow({ message, onFocusSystem }: {
  message: PerimeterMessage; onFocusSystem: (systemId: number) => void;
}) {
  const { t, locale } = useI18n();
  const meta = message.meta;
  const kind = meta ? meta.severity : message.role === 'user' ? 'user' : 'answer';
  const ruleKey = meta ? advisoryRuleKey(meta.rule) : null;
  const parsed = parseSqlUtcDate(message.createdAt);
  const date = Number.isFinite(parsed.getTime()) ? parsed : null;
  return <article className={`pchat-row pchat-row--${kind}`}>
    <header className="pchat-row-head">
      <span>{meta ? t(meta.severity === 'danger' ? 'pchatDanger' : meta.severity === 'warn' ? 'pchatWarn' : 'pchatInfo') : t(message.role === 'user' ? 'pchatPilot' : 'perimeterChat')}</span>
      {meta && ruleKey ? <span>{t(ruleKey)}</span> : null}
      {meta && meta.repeats > 0 ? <span>×{meta.repeats + 1}</span> : null}
    </header>
    <div className="pchat-markdown"><MarkdownMessage content={message.content} /></div>
    <footer className="pchat-row-foot">
      {date ? <time dateTime={date.toISOString()}>{date.toLocaleTimeString(locale === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</time> : null}
      {meta?.systemId != null ? <button type="button" className="pchat-link" onClick={() => onFocusSystem(meta.systemId!)}>{t('perimeterShowOnMap')}</button> : null}
      {meta?.killmailId ? <a href={`https://eve-kill.com/kill/${meta.killmailId}`} target="_blank" rel="noreferrer noopener">{t('perimeterKillmail')}</a> : null}
    </footer>
  </article>;
});

function Waiting({ request }: { request: WebAgentRequest | null }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const start = useRef(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = perimeterElapsedSeconds(request?.createdAt, now, start.current);
  return <div className="pchat-waiting" role="status">
    <span className="pchat-pulse" aria-hidden="true" />
    <span>{t(request?.streamText ? 'pchatWriting' : request?.status === 'queued' ? 'pchatQueued' : 'perimeterThinking')}</span>
    <time aria-live="off">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</time>
  </div>;
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => Promise<boolean> }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const submit = async () => {
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft('');
    if (!await onSend(text)) setDraft((current) => current || text);
  };
  return <form className="pchat-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <textarea value={draft} onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} placeholder={t('perimeterAskPlaceholder')} rows={2} maxLength={4000} aria-label={t('message')} />
    <button className="pchat-send" type="submit" disabled={disabled || !draft.trim()} aria-label={t('send')}>↑</button>
  </form>;
}
