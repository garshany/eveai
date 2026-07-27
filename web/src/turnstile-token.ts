// Жизненный цикл одноразового токена Turnstile. Чистая логика без React:
// токен нельзя переиспользовать, поэтому после неудачного запроса или истечения
// он инвалидируется, а виджету требуется reset (у нас — перемонтирование).

export type TurnstileTokenState =
  | { phase: 'idle' }
  | { phase: 'ready'; token: string }
  | { phase: 'inFlight'; token: string };

export type TurnstileTokenEvent =
  | { type: 'tokenReceived'; token: string }
  | { type: 'requestStarted' }
  | { type: 'requestSucceeded' }
  | { type: 'requestFailed' }
  | { type: 'tokenExpired' };

export type TurnstileTokenTransition = {
  state: TurnstileTokenState;
  resetWidget: boolean;
};

export const INITIAL_TURNSTILE_TOKEN_STATE: TurnstileTokenState = { phase: 'idle' };

export function reduceTurnstileToken(
  state: TurnstileTokenState,
  event: TurnstileTokenEvent,
): TurnstileTokenTransition {
  switch (event.type) {
    case 'tokenReceived':
      return { state: { phase: 'ready', token: event.token }, resetWidget: false };
    case 'requestStarted':
      // Повторный запрос с тем же токеном виджет не сбрасывает.
      if (state.phase === 'ready') {
        return { state: { phase: 'inFlight', token: state.token }, resetWidget: false };
      }
      return { state, resetWidget: false };
    case 'requestSucceeded':
      return { state: INITIAL_TURNSTILE_TOKEN_STATE, resetWidget: false };
    case 'requestFailed':
      // Токен сгорел на сервере (403/429/503/сеть) — сбрасываем всегда.
      return { state: INITIAL_TURNSTILE_TOKEN_STATE, resetWidget: true };
    case 'tokenExpired':
      if (state.phase === 'idle') return { state, resetWidget: false };
      return { state: INITIAL_TURNSTILE_TOKEN_STATE, resetWidget: true };
  }
}
