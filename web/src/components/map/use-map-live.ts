/**
 * Подписка на живой поток карты.
 *
 * EventSource сам переподключается и сам шлёт Last-Event-ID, поэтому ручной
 * ретрай здесь только для случаев, когда сервер закрыл поток намеренно
 * (отказ по лимиту, фатальная ошибка ESI) — в этих случаях повтор должен быть
 * редким и с откатом, иначе браузер начнёт долбить отказавший эндпоинт.
 *
 * Хук ничего не рисует: он владеет только состоянием потока.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapBubble, MapKillEvent, MapLocation, PerimeterMessage } from '../../types';

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'offline' | 'stopped';

export type LiveAdvisory = {
  advisory: {
    rule: string;
    severity: 'info' | 'warn' | 'danger';
    text: { ru: string; en: string };
    systemId: number | null;
    killmailId: number | null;
    repeats: number;
    at: string;
  };
  message: PerimeterMessage;
};

export type MapLiveState = {
  status: LiveStatus;
  location: MapLocation | null;
  bubble: MapBubble | null;
  threadId: string | null;
  /** Свежие килы для вспышек; потребитель забирает и очищает. */
  killEvents: MapKillEvent[];
  advisories: LiveAdvisory[];
  warning: string | null;
  /** Растёт на каждом прыжке — камера использует это как триггер. */
  jumpCounter: number;
};

const MAX_RETRY_MS = 60_000;
const BASE_RETRY_MS = 5_000;

export function useMapLive(enabled: boolean): MapLiveState & { reconnect: () => void } {
  const [state, setState] = useState<MapLiveState>({
    status: 'idle',
    location: null,
    bubble: null,
    threadId: null,
    killEvents: [],
    advisories: [],
    warning: null,
    jumpCounter: 0,
  });

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<{ attempts: number; timer: number | null }>({ attempts: 0, timer: null });
  const [manualNonce, setManualNonce] = useState(0);

  const reconnect = useCallback(() => {
    retryRef.current.attempts = 0;
    setManualNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      sourceRef.current?.close();
      sourceRef.current = null;
      setState((previous) => ({ ...previous, status: 'idle' }));
      return;
    }

    let closed = false;
    setState((previous) => ({ ...previous, status: 'connecting', warning: null }));

    const source = new EventSource('/api/web/map/live', { withCredentials: true });
    sourceRef.current = source;

    const on = <T,>(name: string, handler: (payload: T) => void): void => {
      source.addEventListener(name, (event) => {
        if (closed) return;
        try {
          handler(JSON.parse((event as MessageEvent<string>).data) as T);
        } catch {
          // Битый кадр — это дефект транспорта, а не повод рвать поток:
          // следующее событие, скорее всего, придёт целым.
        }
      });
    };

    on<{ threadId: string }>('ready', (payload) => {
      retryRef.current.attempts = 0;
      setState((previous) => ({ ...previous, status: 'live', threadId: payload.threadId }));
    });

    on<{ location: MapLocation; jumped: boolean }>('location', (payload) => {
      setState((previous) => ({
        ...previous,
        status: 'live',
        location: payload.location,
        jumpCounter: payload.jumped ? previous.jumpCounter + 1 : previous.jumpCounter,
      }));
    });

    on<{ bubble: MapBubble }>('intel', (payload) => {
      setState((previous) => ({ ...previous, bubble: payload.bubble }));
    });

    on<{ kill: MapKillEvent }>('kill', (payload) => {
      setState((previous) => ({
        ...previous,
        // Ограничение сверху: за долгий полёт очередь вспышек иначе растёт
        // бесконечно, а показываются всё равно только свежие.
        killEvents: [...previous.killEvents, payload.kill].slice(-50),
      }));
    });

    on<LiveAdvisory>('advisory', (payload) => {
      setState((previous) => ({ ...previous, advisories: [...previous.advisories, payload].slice(-100) }));
    });

    on<{ at: string }>('offline', () => {
      setState((previous) => ({ ...previous, status: 'offline' }));
    });

    on<{ message: string; fatal?: boolean }>('warning', (payload) => {
      setState((previous) => ({
        ...previous,
        warning: payload.message,
        status: payload.fatal ? 'stopped' : previous.status,
      }));
    });

    source.onerror = () => {
      if (closed) return;
      // EventSource переподключается сам, пока соединение не закрыто сервером
      // окончательно. Здесь только отражаем состояние и планируем редкий
      // ручной повтор для окончательно закрытого потока.
      if (source.readyState === EventSource.CLOSED) {
        setState((previous) => ({ ...previous, status: 'stopped' }));
        const attempts = retryRef.current.attempts + 1;
        retryRef.current.attempts = attempts;
        const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (attempts - 1));
        retryRef.current.timer = window.setTimeout(() => setManualNonce((v) => v + 1), delay);
      } else {
        setState((previous) => ({ ...previous, status: 'connecting' }));
      }
    };

    return () => {
      closed = true;
      source.close();
      sourceRef.current = null;
      if (retryRef.current.timer !== null) {
        window.clearTimeout(retryRef.current.timer);
        retryRef.current.timer = null;
      }
    };
  }, [enabled, manualNonce]);

  return { ...state, reconnect };
}
