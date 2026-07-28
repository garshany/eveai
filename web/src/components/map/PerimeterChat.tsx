/**
 * Чат «Периметра».
 *
 * Это не лента уведомлений, а настоящий тред: агент пишет в него сам, пилот
 * отвечает туда же, история переживает перезагрузку. Проактивные сообщения
 * несут якорь (система, килмейл), поэтому по ним можно кликнуть и увести
 * камеру к тому, о чём речь.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { PerimeterMessage } from '../../types';
import type { LiveAdvisory } from './use-map-live';
import { advisoryRuleKey } from './labels';

export type MapAskContext = {
  systemId: number | null;
  selectedSystemId: number | null;
  shipTypeId: number | null;
  radius: number | null;
  band: string | null;
};

type Props = {
  csrfToken: string;
  /** Живые советы приходят потоком и дописываются к загруженной истории. */
  advisories: LiveAdvisory[];
  /** Что пилот сейчас видит — уходит вместе с вопросом, без уточнений. */
  context: MapAskContext;
  onFocusSystem: (systemId: number) => void;
};

export type SeverityFilter = 'all' | 'important' | 'quiet';

const SEVERITY_RANK = { info: 0, warn: 1, danger: 2 } as const;

export function PerimeterChat({ csrfToken, advisories, context, onFocusSystem }: Props) {
  const { t, locale } = useI18n();
  const [messages, setMessages] = useState<PerimeterMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SeverityFilter>('all');
  const [awaiting, setAwaiting] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await webApi.map.chat();
        if (!cancelled) setMessages(payload.messages);
      } catch {
        // История — сопровождающий слой: её отсутствие не должно ломать карту.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Поток отдаёт уже сохранённое сообщение, поэтому дедуп идёт по его id и
  // повторная загрузка истории не задваивает ленту.
  useEffect(() => {
    if (advisories.length === 0) return;
    setMessages((previous) => {
      const known = new Set(previous.map((message) => message.id));
      const additions = advisories
        .map((entry) => entry.message)
        .filter((message) => !known.has(message.id));
      return additions.length > 0 ? [...previous, ...additions] : previous;
    });
  }, [advisories]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  useEffect(() => () => {
    if (pollRef.current !== null) window.clearTimeout(pollRef.current);
  }, []);

  const reloadHistory = async (): Promise<void> => {
    try {
      const payload = await webApi.map.chat();
      setMessages(payload.messages);
    } catch {
      // История обновится на следующем открытии панели.
    }
  };

  /**
   * Ответ приходит через ту же durable-очередь, что и обычный чат: ждём, пока
   * запрос дойдёт до терминального состояния, и перечитываем тред — сообщение агента к тому
   * моменту уже сохранено.
   */
  const awaitAnswer = (requestId: string, attempt = 0): void => {
    if (attempt > 240) {
      setAwaiting(false);
      return;
    }
    pollRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const payload = await webApi.getAgentRequest(requestId);
          if (payload.request.status === 'queued' || payload.request.status === 'running') {
            awaitAnswer(requestId, attempt + 1);
            return;
          }
          if (payload.request.status === 'failed' && payload.request.error) {
            setError(payload.request.error);
          }
          await reloadHistory();
        } catch {
          // Разрыв опроса не должен ломать панель: история подтянется позже.
        } finally {
          setAwaiting(false);
        }
      })();
    }, attempt === 0 ? 800 : 2000);
  };

  const visible = useMemo(() => {
    if (filter === 'all') return messages;
    const floor = filter === 'important' ? SEVERITY_RANK.warn : SEVERITY_RANK.danger;
    return messages.filter((message) => {
      if (!message.meta) return true;
      return SEVERITY_RANK[message.meta.severity] >= floor;
    });
  }, [messages, filter]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    // Оптимистичное сообщение с отрицательным id: он не столкнётся с id из
    // базы, поэтому дедуп по id остаётся корректным.
    const optimistic: PerimeterMessage = {
      id: -Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      meta: null,
    };
    setMessages((previous) => [...previous, optimistic]);
    setDraft('');
    try {
      const accepted = await webApi.map.ask(text, csrfToken, context);
      setAwaiting(true);
      awaitAnswer(accepted.request.requestId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('requestFailed'));
      setMessages((previous) => previous.filter((message) => message.id !== optimistic.id));
      setDraft(text);
    } finally {
      setSending(false);
    }
  };

  return <aside className="perimeter-chat" aria-label={t('perimeterChat')}>
    <header className="perimeter-chat__head">
      <span className="perimeter-chat__title">{t('perimeterChat')}</span>
      <div className="perimeter-chat__filter" role="group" aria-label={t('perimeterFilter')}>
        {(['all', 'important', 'quiet'] as SeverityFilter[]).map((value) => <button
          key={value}
          type="button"
          className={`perimeter-chip${filter === value ? ' perimeter-chip--active' : ''}`}
          onClick={() => setFilter(value)}
        >{t(value === 'all' ? 'perimeterFilterAll' : value === 'important' ? 'perimeterFilterImportant' : 'perimeterFilterQuiet')}</button>)}
      </div>
    </header>

    <div className="perimeter-chat__list" ref={listRef}>
      {visible.length === 0
        ? <p className="perimeter-chat__empty">{t('perimeterChatEmpty')}</p>
        : visible.map((message) => <ChatRow
          key={message.id}
          message={message}
          locale={locale}
          onFocusSystem={onFocusSystem}
        />)}
    </div>

    {awaiting ? <p className="perimeter-chat__pending">{t('perimeterThinking')}</p> : null}
    {error ? <p className="perimeter-chat__error" role="alert">{error}</p> : null}

    <form
      className="perimeter-chat__composer"
      onSubmit={(event) => { event.preventDefault(); void send(); }}
    >
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={t('perimeterAskPlaceholder')}
        rows={2}
        aria-label={t('message')}
      />
      <button type="submit" disabled={sending || draft.trim().length === 0}>
        {t('send')}
      </button>
    </form>
  </aside>;
}

function ChatRow({
  message,
  locale,
  onFocusSystem,
}: {
  message: PerimeterMessage;
  locale: 'ru' | 'en';
  onFocusSystem: (systemId: number) => void;
}) {
  const { t } = useI18n();
  const meta = message.meta;
  const severity = meta?.severity ?? 'info';
  const anchored = meta?.systemId ?? null;

  return <article
    className={`perimeter-msg perimeter-msg--${message.role} perimeter-msg--${severity}`}
  >
    {meta ? <header className="perimeter-msg__head">
      <span className={`perimeter-badge perimeter-badge--${severity}`}>{advisoryRuleKey(meta.rule) ? t(advisoryRuleKey(meta.rule)!) : meta.rule}</span>
      {meta.repeats > 0 ? <span className="perimeter-msg__repeats">×{meta.repeats + 1}</span> : null}
    </header> : null}
    <p className="perimeter-msg__text">{message.content}</p>
    <footer className="perimeter-msg__foot">
      <time dateTime={message.createdAt}>
        {new Date(message.createdAt).toLocaleTimeString(locale === 'ru' ? 'ru-RU' : 'en-GB', {
          hour: '2-digit', minute: '2-digit',
        })}
      </time>
      {anchored !== null ? <button
        type="button"
        className="perimeter-msg__anchor"
        onClick={() => onFocusSystem(anchored)}
      >{t('perimeterShowOnMap')}</button> : null}
      {meta?.killmailId ? <a
        href={`https://eve-kill.com/kill/${meta.killmailId}`}
        target="_blank"
        rel="noreferrer noopener"
      >{t('perimeterKillmail')}</a> : null}
    </footer>
  </article>;
}
