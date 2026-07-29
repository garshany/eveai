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

export type LiveRoute = {
  systemIds: number[];
  jumps: number;
  mode: string;
  riskWeight: number;
};

export type MapLiveState = {
  status: LiveStatus;
  location: MapLocation | null;
  bubble: MapBubble | null;
  threadId: string | null;
  /**
   * Маршрут, который сейчас считается активным на сервере.
   *
   * Он приходит потоком, а не только из ответа на построение: маршрут может
   * проложить агент в чате, и линия на карте обязана согласоваться с тем, что
   * он сказал и что выставил в автопилот.
   */
  route: LiveRoute | null;
  /** Свежие килы для вспышек; потребитель забирает и очищает. */
  killEvents: MapKillEvent[];
  advisories: LiveAdvisory[];
  warning: string | null;
  /** Растёт на каждом прыжке — камера использует это как триггер. */
  jumpCounter: number;
};

const MAX_RETRY_MS = 60_000;
const BASE_RETRY_MS = 5_000;

export function useMapLive(enabled: boolean, radius: number | null): MapLiveState & { reconnect: () => void } {
  const [state, setState] = useState<MapLiveState>({
    status: 'idle',
    location: null,
    bubble: null,
    threadId: null,
    route: null,
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

    const query = radius === null ? '' : `?radius=${encodeURIComponent(radius)}`;
    const source = new EventSource(`/api/web/map/live${query}`, { withCredentials: true });
    sourceRef.current = source;
    // Set by a fatal server-side stop. EventSource reconnects on its own after a
    // plain EOF, which would recreate the session and reset its failure counter
    // every few seconds through an outage — exactly the storm the server-side
    // backoff exists to prevent.
    let fatal = false;

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

    on<{ route: LiveRoute | null }>('route', (payload) => {
      setState((previous) => ({ ...previous, route: payload.route }));
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
      if (payload.fatal) {
        fatal = true;
        // Closing here is the only thing that actually stops the browser from
        // retrying; readyState after a server EOF is CONNECTING, not CLOSED.
        source.close();
      }
      setState((previous) => ({
        ...previous,
        warning: payload.message,
        status: payload.fatal ? 'stopped' : previous.status,
      }));
    });

    source.onerror = () => {
      if (closed) return;
      // A fatal stop, or a stream the browser has given up on: reconnect on our
      // own schedule rather than the browser's few-second default.
      if (fatal || source.readyState === EventSource.CLOSED) {
        source.close();
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
  }, [enabled, manualNonce, radius]);

  return { ...state, reconnect };
}
