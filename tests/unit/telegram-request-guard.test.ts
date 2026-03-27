import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: {
      requestWindowMs: 60000,
      maxRequestsPerWindow: 2,
      maxActiveRequestsGlobal: 3,
    },
  },
}));

import {
  evaluateTelegramRequestAllowance,
  resetTelegramRequestGuardForTests,
} from '../../src/telegram/request-guard.js';

afterEach(() => {
  resetTelegramRequestGuardForTests();
});

describe('evaluateTelegramRequestAllowance', () => {
  it('rejects overlapping active requests for the same chat', () => {
    const result = evaluateTelegramRequestAllowance({
      chatId: 1,
      userId: 1,
      hasActiveRequest: true,
      activeRequestCount: 1,
      now: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Предыдущий запрос');
  });

  it('rejects requests when the global active ceiling is reached', () => {
    const result = evaluateTelegramRequestAllowance({
      chatId: 1,
      userId: 1,
      hasActiveRequest: false,
      activeRequestCount: 3,
      now: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('перегружен');
  });

  it('rate limits repeated requests in the configured window', () => {
    const first = evaluateTelegramRequestAllowance({
      chatId: 1,
      userId: 7,
      hasActiveRequest: false,
      activeRequestCount: 0,
      now: 1000,
    });
    const second = evaluateTelegramRequestAllowance({
      chatId: 1,
      userId: 7,
      hasActiveRequest: false,
      activeRequestCount: 0,
      now: 2000,
    });
    const third = evaluateTelegramRequestAllowance({
      chatId: 1,
      userId: 7,
      hasActiveRequest: false,
      activeRequestCount: 0,
      now: 3000,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    expect(third.message).toContain('Слишком много запросов');
  });

  it('allows new requests after the window expires', () => {
    expect(evaluateTelegramRequestAllowance({
      chatId: 1,
      userId: 7,
      hasActiveRequest: false,
      activeRequestCount: 0,
      now: 1000,
    }).ok).toBe(true);
    expect(evaluateTelegramRequestAllowance({
      chatId: 1,
      userId: 7,
      hasActiveRequest: false,
      activeRequestCount: 0,
      now: 2000,
    }).ok).toBe(true);
    expect(evaluateTelegramRequestAllowance({
      chatId: 1,
      userId: 7,
      hasActiveRequest: false,
      activeRequestCount: 0,
      now: 62001,
    }).ok).toBe(true);
  });
});
