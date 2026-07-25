import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.ALLOWED_TELEGRAM_USER_ID = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.EVE_CLIENT_ID = 'test';
process.env.EVE_CLIENT_SECRET = 'test';
process.env.DEFAULT_MARKET_REGION_ID = '10000002';
process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';

const {
  waitForInFlightRequests,
  rememberInFlightRequest,
  clearInFlightRequest,
  activeRequestCount,
  resetChatRequestGuardForTests,
} = await import('../../src/chat/shared.js');

beforeEach(() => {
  resetChatRequestGuardForTests();
});

afterEach(() => {
  resetChatRequestGuardForTests();
});

describe('waitForInFlightRequests', () => {
  it('returns immediately when nothing is running', async () => {
    const started = Date.now();
    await expect(waitForInFlightRequests(5_000, 10)).resolves.toBe(0);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('waits for a running turn and reports a clean drain', async () => {
    rememberInFlightRequest(42, 'thread-1', 'вопрос', 'token-1');
    setTimeout(() => clearInFlightRequest(42, 'token-1'), 60);

    await expect(waitForInFlightRequests(5_000, 10)).resolves.toBe(0);
    expect(activeRequestCount()).toBe(0);
  });

  it('gives up at the deadline and reports what is still running', async () => {
    rememberInFlightRequest(42, 'thread-1', 'долгий ход', 'token-1');
    rememberInFlightRequest(43, 'thread-2', 'ещё один', 'token-2');

    const started = Date.now();
    // The caller must learn the turns were abandoned, not just that time ran out.
    await expect(waitForInFlightRequests(80, 10)).resolves.toBe(2);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(1_500);
  });

  it('drains on an injected counter so other lanes are not invisible', async () => {
    // Web turns live in their own coordinator, not in the chat in-flight map.
    // Shutdown passes a combined counter; the wait must honour it.
    let webTurns = 2;
    setTimeout(() => { webTurns = 0; }, 60);

    await expect(waitForInFlightRequests(5_000, 10, () => activeRequestCount() + webTurns))
      .resolves.toBe(0);
  });

  it('reports lane work left over at the deadline', async () => {
    await expect(waitForInFlightRequests(60, 10, () => 3)).resolves.toBe(3);
  });

  it('skips the wait entirely when the drain is disabled', async () => {
    rememberInFlightRequest(42, 'thread-1', 'вопрос', 'token-1');

    const started = Date.now();
    await expect(waitForInFlightRequests(0, 10)).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('never waits past the deadline even with a long poll interval', async () => {
    rememberInFlightRequest(42, 'thread-1', 'вопрос', 'token-1');

    const started = Date.now();
    // Poll interval far larger than the budget: the wait must clamp to the
    // deadline instead of overshooting a shutdown by seconds.
    await expect(waitForInFlightRequests(50, 5_000)).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
