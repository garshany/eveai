import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { CheckIcon, CompassMark, MarketIcon, MenuIcon, PaperclipIcon, RouteIcon, SendIcon, TargetIcon } from '../icons';
import type { ChatMessage } from '../types';
import { LocaleSwitch, useI18n } from '../i18n';
import { MarkdownMessage } from './MarkdownMessage';

type ChatScreenProps = { title: string; messages: ChatMessage[]; busy: boolean; error: string | null; onMenu: () => void; onSend: (message: string) => Promise<void>; onCancel: () => void };

export function ChatScreen({ title, messages, busy, error, onMenu, onSend, onCancel }: ChatScreenProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const routeImage = `${import.meta.env.BASE_URL}assets/orbit-route.png`;
  const suggestions = [
    { text: t('suggestionRoute'), Icon: RouteIcon },
    { text: t('suggestionMarket'), Icon: MarketIcon },
    { text: t('suggestionLosses'), Icon: TargetIcon },
  ];
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, busy]);
  const submit = async (value = draft) => { const message = value.trim(); if (!message || busy) return; setDraft(''); await onSend(message); };

  return <section className="chat-canvas" style={{ '--chat-route-image': `url(${routeImage})` } as CSSProperties}>
    <header className="chat-header"><button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button><h1>{title}</h1><div className="chat-header__actions"><div className="connection-state"><span />{t('connected')}</div><LocaleSwitch /></div></header>
    <div className="chat-scroll" aria-live="polite">
      <section className={`chat-intro${messages.length > 0 ? ' chat-intro--compact' : ''}`}><div className="chat-intro__orbit" aria-hidden="true" /><h2>{t('introTitle')}</h2><p>{t('introLead')}</p><div className="suggestions">{suggestions.map(({ text, Icon }) => <button type="button" key={text} onClick={() => void submit(text)} disabled={busy}><Icon size={23} /><span>{text}</span></button>)}</div></section>
      {messages.length > 0 ? <div className="message-thread">{messages.map((message) => <MessageBubble key={message.id} message={message} />)}{busy ? <ThinkingMessage onCancel={onCancel} /> : null}<div ref={endRef} /></div> : busy ? <div className="message-thread"><ThinkingMessage onCancel={onCancel} /><div ref={endRef} /></div> : null}
    </div>
    <div className="composer-region">{error ? <div className="composer-error" role="alert">{error}</div> : null}<div className="composer"><button className="icon-button composer__utility" type="button" aria-label={t('attachments')} disabled><PaperclipIcon size={24} /></button><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder={t('placeholder')} aria-label={t('message')} rows={1} maxLength={2000} disabled={busy} /><button className="send-button" type="button" onClick={() => void submit()} disabled={!draft.trim() || busy} aria-label={t('send')}><SendIcon size={25} /></button></div></div>
  </section>;
}

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const isUser = message.role === 'user';
  return <article className={`message message--${message.role}`}>{!isUser ? <div className="assistant-mark"><CompassMark size={24} /></div> : null}<div className="message__body"><div className="message__content"><MarkdownMessage content={message.content} /></div>{message.activity?.length ? <details className="activity-trace"><summary>{t('checkedSources')}: {message.activity.length}</summary><div className="activity-trace__steps">{message.activity.map((step, index) => <div key={`${step.name}-${index}`}><CheckIcon size={18} /><span>{humanizeToolName(step.name)}</span><small>{step.detail || t('completed')}</small></div>)}</div></details> : null}</div></article>;
});

function ThinkingMessage({ onCancel }: { onCancel: () => void }) { const { t } = useI18n(); return <article className="message message--assistant message--thinking"><div className="assistant-mark"><CompassMark size={24} /></div><div className="thinking-dots" aria-label={t('thinking')}><span /><span /><span /></div><button className="thinking-cancel" type="button" onClick={onCancel}>{t('cancelRequest')}</button></article>; }
function humanizeToolName(name: string) { return name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
