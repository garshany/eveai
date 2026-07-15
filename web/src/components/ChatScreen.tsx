import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CheckIcon,
  CompassMark,
  MarketIcon,
  MenuIcon,
  PaperclipIcon,
  RouteIcon,
  SendIcon,
  TargetIcon,
} from '../icons';
import type { ChatMessage, SessionPayload } from '../types';
import { MarkdownMessage } from './MarkdownMessage';

const SUGGESTIONS = [
  { text: 'Построй безопасный маршрут', Icon: RouteIcon },
  { text: 'Сравни цены в регионах', Icon: MarketIcon },
  { text: 'Разбери последние потери', Icon: TargetIcon },
] as const;

type ChatScreenProps = {
  title: string;
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  runtime: SessionPayload['runtime'];
  onMenu: () => void;
  onSend: (message: string) => Promise<void>;
};

export function ChatScreen({ title, messages, busy, error, runtime, onMenu, onSend }: ChatScreenProps) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const routeImage = `${import.meta.env.BASE_URL}assets/orbit-route.png`;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  const submit = async (value = draft) => {
    const message = value.trim();
    if (!message || busy) return;
    setDraft('');
    await onSend(message);
  };

  return (
    <section className="chat-canvas" style={{ '--chat-route-image': `url(${routeImage})` } as CSSProperties}>
      <header className="chat-header">
        <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label="Открыть диалоги">
          <MenuIcon />
        </button>
        <h1>{title}</h1>
        <div className="connection-state"><span />Подключено</div>
      </header>

      <div className="chat-scroll" aria-live="polite">
        <section className={`chat-intro${messages.length > 0 ? ' chat-intro--compact' : ''}`}>
          <div className="chat-intro__orbit" aria-hidden="true" />
          <h2>Чем займёмся, капсулёр?</h2>
          <p>Маршруты, рынок, разведка и разбор боёв — в одном диалоге.</p>
          <div className="suggestions">
            {SUGGESTIONS.map(({ text, Icon }) => (
              <button type="button" key={text} onClick={() => void submit(text)} disabled={busy}>
                <Icon size={23} />
                <span>{text}</span>
              </button>
            ))}
          </div>
        </section>

        {messages.length > 0 ? (
          <div className="message-thread">
            {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
            {busy ? <ThinkingMessage /> : null}
            <div ref={endRef} />
          </div>
        ) : busy ? (
          <div className="message-thread"><ThinkingMessage /><div ref={endRef} /></div>
        ) : null}
      </div>

      <div className="composer-region">
        {error ? <div className="composer-error" role="alert">{error}</div> : null}
        <div className="composer">
          <button className="icon-button composer__utility" type="button" aria-label="Вложения пока недоступны" disabled>
            <PaperclipIcon size={24} />
          </button>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Спросите о Новом Эдеме…"
            aria-label="Сообщение"
            rows={1}
            maxLength={2000}
            disabled={busy}
          />
          <button className="send-button" type="button" onClick={() => void submit()} disabled={!draft.trim() || busy} aria-label="Отправить сообщение">
            <SendIcon size={25} />
          </button>
        </div>
        <div className="runtime-state">
          <span />{formatRuntimeLabel(runtime)} · инструменты готовы
        </div>
      </div>
    </section>
  );
}

function formatRuntimeLabel(runtime: SessionPayload['runtime']): string {
  const model = runtime.model
    .split('-')
    .map((part) => part === 'gpt' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
  return runtime.reasoningEffort === 'auto'
    ? `${runtime.providerName} · ${model}`
    : `${runtime.providerName} · ${model} · ${runtime.reasoningEffort}`;
}

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <article className={`message message--${message.role}`}>
      {!isUser ? <div className="assistant-mark"><CompassMark size={24} /></div> : null}
      <div className="message__body">
        <div className="message__content"><MarkdownMessage content={message.content} /></div>
        {message.activity && message.activity.length > 0 ? (
          <details className="activity-trace">
            <summary>Проверено источников: {message.activity.length}</summary>
            <div className="activity-trace__steps">
              {message.activity.map((step, index) => (
                <div key={`${step.name}-${index}`}>
                  <CheckIcon size={18} />
                  <span>{humanizeToolName(step.name)}</span>
                  <small>{step.detail || 'Завершено'}</small>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
});

function ThinkingMessage() {
  return (
    <article className="message message--assistant message--thinking">
      <div className="assistant-mark"><CompassMark size={24} /></div>
      <div className="thinking-dots" aria-label="Модель формирует ответ"><span /><span /><span /></div>
    </article>
  );
}

function humanizeToolName(name: string): string {
  return name
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
