/**
 * Сторож живого потока «Периметра».
 *
 * Сердцебиение SSE — комментарии, а EventSource их не показывает, поэтому
 * полумёртвое соединение (прокси держит сокет, сервер давно ничего не шлёт)
 * снаружи выглядит живым. Судить можно только по настоящим событиям.
 */

/** Не меньше этого без единого события — поток считается зависшим. */
export const STALE_STREAM_MS = 45_000;
/**
 * До первой позиции сервер не строит пузырь и молчит между попытками ESI,
 * а их откат доходит до минуты: короткий порог рвал бы здоровый поток.
 */
export const STALE_BEFORE_LOCATION_MS = 90_000;
/** Как часто продлевать аренду живой сессии, пока вкладку видно. */
export const LIVE_TOUCH_INTERVAL_MS = 4 * 60_000;

export function isStreamStale(input: {
  now: number;
  /** Когда пришло последнее событие любого типа (или открылся поток). */
  lastEventAt: number;
  sawLocation: boolean;
  /** Интервал опроса позиции из `ready`; null, пока сервер его не назвал. */
  pollSeconds: number | null;
}): boolean {
  const pollFloor = input.pollSeconds !== null && input.pollSeconds > 0 ? input.pollSeconds * 3_000 : 0;
  const limit = Math.max(input.sawLocation ? STALE_STREAM_MS : STALE_BEFORE_LOCATION_MS, pollFloor);
  return input.now - input.lastEventAt > limit;
}
