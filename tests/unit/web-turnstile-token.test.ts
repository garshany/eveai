import { describe, expect, it } from 'vitest';
import {
  INITIAL_TURNSTILE_TOKEN_STATE,
  reduceTurnstileToken,
  type TurnstileTokenState,
} from '../../web/src/turnstile-token.js';

const ready: TurnstileTokenState = { phase: 'ready', token: 'token-1' };
const inFlight: TurnstileTokenState = { phase: 'inFlight', token: 'token-1' };

describe('reduceTurnstileToken', () => {
  it('stores the token on tokenReceived', () => {
    const next = reduceTurnstileToken(INITIAL_TURNSTILE_TOKEN_STATE, { type: 'tokenReceived', token: 'token-1' });
    expect(next).toEqual({ state: ready, resetWidget: false });
  });

  it('requestStarted moves ready to inFlight without resetting the widget', () => {
    const next = reduceTurnstileToken(ready, { type: 'requestStarted' });
    expect(next).toEqual({ state: inFlight, resetWidget: false });
  });

  it('a repeated requestStarted while inFlight keeps the token and does not reset', () => {
    const next = reduceTurnstileToken(inFlight, { type: 'requestStarted' });
    expect(next).toEqual({ state: inFlight, resetWidget: false });
  });

  it('requestSucceeded clears the token without a widget reset', () => {
    const next = reduceTurnstileToken(inFlight, { type: 'requestSucceeded' });
    expect(next).toEqual({ state: INITIAL_TURNSTILE_TOKEN_STATE, resetWidget: false });
  });

  it.each([
    ['idle', INITIAL_TURNSTILE_TOKEN_STATE],
    ['ready', ready],
    ['inFlight', inFlight],
  ] as const)('requestFailed from %s invalidates the token and requires a reset', (_label, state) => {
    const next = reduceTurnstileToken(state, { type: 'requestFailed' });
    expect(next.state).toEqual(INITIAL_TURNSTILE_TOKEN_STATE);
    expect(next.resetWidget).toBe(true);
  });

  it.each([
    ['ready', ready],
    ['inFlight', inFlight],
  ] as const)('tokenExpired from %s invalidates the token and requires a reset', (_label, state) => {
    const next = reduceTurnstileToken(state, { type: 'tokenExpired' });
    expect(next.state).toEqual(INITIAL_TURNSTILE_TOKEN_STATE);
    expect(next.resetWidget).toBe(true);
  });

  it('tokenExpired while idle is a no-op (widget already shows its own error)', () => {
    const next = reduceTurnstileToken(INITIAL_TURNSTILE_TOKEN_STATE, { type: 'tokenExpired' });
    expect(next).toEqual({ state: INITIAL_TURNSTILE_TOKEN_STATE, resetWidget: false });
  });

  it('a fresh token can be requested after a failure reset', () => {
    const failed = reduceTurnstileToken(inFlight, { type: 'requestFailed' });
    const retried = reduceTurnstileToken(failed.state, { type: 'tokenReceived', token: 'token-2' });
    expect(retried.state).toEqual({ phase: 'ready', token: 'token-2' });
    const restarted = reduceTurnstileToken(retried.state, { type: 'requestStarted' });
    expect(restarted).toEqual({ state: { phase: 'inFlight', token: 'token-2' }, resetWidget: false });
  });
});
