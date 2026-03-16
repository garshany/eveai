import { describe, expect, it } from 'vitest';
import { isTelegramUserAllowed } from '../../src/telegram/access.js';

describe('isTelegramUserAllowed', () => {
  it('allows any user when whitelist is disabled with 0', () => {
    expect(isTelegramUserAllowed(undefined, 0)).toBe(true);
    expect(isTelegramUserAllowed(1, 0)).toBe(true);
    expect(isTelegramUserAllowed(999999, 0)).toBe(true);
  });

  it('allows only the configured user when whitelist is enabled', () => {
    expect(isTelegramUserAllowed(42, 42)).toBe(true);
    expect(isTelegramUserAllowed(43, 42)).toBe(false);
    expect(isTelegramUserAllowed(undefined, 42)).toBe(false);
  });
});
