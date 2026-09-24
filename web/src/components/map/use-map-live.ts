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
import { webApi } from '../../api';
import { isStreamStale, LIVE_TOUCH_INTERVAL_MS } from './live-watchdog';
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
  /**
   * True once the stream has told us what the route is — including "there is
   * none".
   *
   * Without this the screen cannot tell "the server says no route" from "the
   * server has not spoken yet", and falls back to the last route this tab
   * planned. That resurrects a line the server has just expired or cleared.
   */
  routeKnown: boolean;
  /** Свежие килы для вспышек; потребитель забирает и очищает. */
  killEvents: MapKillEvent[];
  advisories: LiveAdvisory[];
  warning: string | null;
  /** Растёт на каждом прыжке — камера использует это как триггер. */
  jumpCounter: number;
};

const MAX_RETRY_MS = 60_000;
const BASE_RETRY_MS = 5_000;

/** How often the watchdog looks at the stream; cheap, it only compares times. */
const WATCHDOG_TICK_MS = 5_000;

export function useMapLive(
  enabled: boolean,
  radius: number | null,
  csrfToken: string | null = null,
): MapLiveState & { reconnect: () => void } {
  const [state, setState] = useState<MapLiveState>({
    status: 'idle',
    location: null,
    bubble: null,
    threadId: null,
    route: null,
    routeKnown: false,
    killEvents: [],
    advisories: [],
    warning: null,
    jumpCounter: 0,
  });

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<{ attempts: number; timer: number | null }>({ attempts: 0, timer: null });
  const [manualNonce, setManualNonce] = useState(0);
  // Read through a ref: a rotated token must not tear down a healthy stream.
  const csrfRef = useRef(csrfToken);
  csrfRef.current = csrfToken;

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
    // Whether the warning on screen came from a fatal stop. Only a transient
    // warning is cleared by the next healthy frame.
    let warningFatal = false;
    let lastEventAt = Date.now();
    let sawLocation = false;
    let pollSeconds: number | null = null;

    const on = <T,>(name: string, handler: (payload: T) => void): void => {
      source.addEventListener(name, (event) => {
        if (closed) return;
        // Any real event proves the socket is alive; heartbeats cannot.
        lastEventAt = Date.now();
        try {
          handler(JSON.parse((event as MessageEvent<string>).data) as T);
        } catch {
          // Битый кадр — это дефект транспорта, а не повод рвать поток:
          // следующее событие, скорее всего, придёт целым.
        }
      });
    };

    on<{ threadId: string; pollSeconds?: number }>('ready', (payload) => {
      retryRef.current.attempts = 0;
      pollSeconds = typeof payload.pollSeconds === 'number' ? payload.pollSeconds : null;
      setState((previous) => ({ ...previous, status: 'live', threadId: payload.threadId }));
    });

    // Every successful ESI poll emits a location, and every successful rebuild
    // an intel frame, so either one is the recovery signal for a transient
    // warning. Without this "ESI 502" stayed on screen for the rest of the
    // session over a perfectly healthy stream. A fatal warning closes the
    // stream, so nothing can arrive to clear it by accident.
    on<{ location: MapLocation; jumped: boolean }>('location', (payload) => {
      sawLocation = true;
      setState((previous) => ({
        ...previous,
        // The poll reports a logged-out pilot's last position every tick; the
        // one-shot 'offline' event must not be overwritten by the next of them.
        status: payload.location.online === false ? 'offline' : 'live',
        location: payload.location,
        jumpCounter: payload.jumped ? previous.jumpCounter + 1 : previous.jumpCounter,
        warning: warningFatal ? previous.warning : null,
      }));
    });

    on<{ bubble: MapBubble }>('intel', (payload) => {
      setState((previous) => ({
        ...previous,
        bubble: payload.bubble,
        warning: warningFatal ? previous.warning : null,
      }));
    });

    on<{ route: LiveRoute | null }>('route', (payload) => {
      setState((previous) => ({ ...previous, route: payload.route, routeKnown: true }));
    });

    on<{ kill: MapKillEvent }>('kill', (payload) => {
      setState((previous) => (
        previous.killEvents.some((kill) => kill.killmailId === payload.kill.killmailId)
          ? previous
          : {
            ...previous,
            // Ограничение сверху: за долгий полёт очередь вспышек иначе растёт
            // бесконечно, а показываются всё равно только свежие.
            killEvents: [...previous.killEvents, payload.kill].slice(-50),
          }
      ));
    });

    // A replayed advisory replaces its earlier copy instead of taking a second
    // slot: the chat dedups by message id anyway, and duplicates here only
    // pushed real warnings out of the capped window sooner.
    on<LiveAdvisory>('advisory', (payload) => {
      setState((previous) => ({
        ...previous,
        advisories: [
          ...previous.advisories.filter((entry) => entry.message.id !== payload.message.id),
          payload,
        ].slice(-100),
      }));
    });

    on<{ at: string }>('offline', () => {
      setState((previous) => ({ ...previous, status: 'offline' }));
    });

    // Reconnect on our own schedule rather than the browser's few-second
    // default. Idempotent per stream: a fatal warning and a later error event
    // must not stack two timers.
    const scheduleRetry = (): void => {
      if (closed || retryRef.current.timer !== null) return;
      const attempts = retryRef.current.attempts + 1;
      retryRef.current.attempts = attempts;
      const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (attempts - 1));
      retryRef.current.timer = window.setTimeout(() => {
        retryRef.current.timer = null;
        setManualNonce((v) => v + 1);
      }, delay);
    };

    on<{ message: string; fatal?: boolean }>('warning', (payload) => {
      warningFatal = payload.fatal === true;
      if (payload.fatal) {
        fatal = true;
        // Closing here is the only thing that actually stops the browser from
        // retrying; readyState after a server EOF is CONNECTING, not CLOSED.
        // A closed EventSource never fires onerror, so the backoff retry has
        // to be scheduled here or the map never reconnects (e.g. after a
        // deploy stops every live session).
        source.close();
        scheduleRetry();
      }
      setState((previous) => ({
        ...previous,
        warning: payload.message,
        status: payload.fatal ? 'stopped' : previous.status,
      }));
    });

    const visible = (): boolean => document.visibilityState !== 'hidden';

    // Watchdog: a proxy can keep a dead socket open indefinitely, and the
    // heartbeat comments that would prove otherwise never reach this code. Only
    // judged while the tab is visible — a background tab's timers are
    // throttled, and nobody is looking at a stale map there anyway.
    const checkStale = (): void => {
      if (closed || fatal || source.readyState === EventSource.CLOSED || !visible()) return;
      if (!isStreamStale({ now: Date.now(), lastEventAt, sawLocation, pollSeconds })) return;
      source.close();
      setState((previous) => ({ ...previous, status: 'connecting' }));
      scheduleRetry();
    };
    const watchdog = window.setInterval(checkStale, WATCHDOG_TICK_MS);

    // Lease ping: the server stops a session that has not jumped for its idle
    // window, so a pilot parked in one system got a fatal stop every quarter
    // hour with the map open. Only while visible, so a forgotten tab still
    // times out and frees its slot.
    const touch = (): void => {
      const token = csrfRef.current;
      if (closed || fatal || source.readyState === EventSource.CLOSED || !visible() || !token) return;
      void webApi.map.touchLive(token).catch(() => undefined);
    };
    const toucher = window.setInterval(touch, LIVE_TOUCH_INTERVAL_MS);
    const onVisibility = (): void => {
      if (!visible()) return;
      touch();
      checkStale();
    };
    document.addEventListener('visibilitychange', onVisibility);

    source.onerror = () => {
      if (closed) return;
      // A fatal stop, or a stream the browser has given up on: reconnect on our
      // own schedule rather than the browser's few-second default.
      if (fatal || source.readyState === EventSource.CLOSED) {
        source.close();
        setState((previous) => ({ ...previous, status: 'stopped' }));
        scheduleRetry();
      } else {
        setState((previous) => ({ ...previous, status: 'connecting' }));
      }
    };

    return () => {
      closed = true;
      window.clearInterval(watchdog);
      window.clearInterval(toucher);
      document.removeEventListener('visibilitychange', onVisibility);
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
