import { describe, expect, it } from 'vitest';

// bot.ts reads config at import — provide the standard hermetic env first.
process.env.ALLOWED_TELEGRAM_USER_ID = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.EVE_CLIENT_ID = 'test';
process.env.EVE_CLIENT_SECRET = 'test';
process.env.DEFAULT_MARKET_REGION_ID = '10000002';
process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';

const { isStaleTelegramUpdate, isTelegramCallbackBacklog } = await import('../../src/telegram/bot.js');

const NOW_MS = 1_800_000_000_000; // fixed clock
const nowSec = NOW_MS / 1000;
// The process booted an hour ago; anything sent before that is a redelivered backlog.
const BOOT_SEC = nowSec - 3600;

describe('isStaleTelegramUpdate', () => {
  it('skips pre-boot updates older than the window (redelivered backlog)', () => {
    expect(isStaleTelegramUpdate(BOOT_SEC - 16 * 60, 15, NOW_MS, BOOT_SEC)).toBe(true);
    expect(isStaleTelegramUpdate(BOOT_SEC - 24 * 3600, 15, NOW_MS, BOOT_SEC)).toBe(true);
  });

  it('passes pre-boot updates that are still inside the window', () => {
    // Fast restart: the update predates boot but is only seconds/minutes old.
    const recentBoot = nowSec - 2;
    expect(isStaleTelegramUpdate(recentBoot - 5, 15, NOW_MS, recentBoot)).toBe(false);
    expect(isStaleTelegramUpdate(nowSec - 14 * 60, 15, NOW_MS, nowSec - 60)).toBe(false);
  });

  it('never drops updates sent after boot, however long they queued behind a turn', () => {
    // A live user message that waited hours in the serial queue must still be answered.
    expect(isStaleTelegramUpdate(BOOT_SEC, 15, NOW_MS, BOOT_SEC)).toBe(false);
    expect(isStaleTelegramUpdate(BOOT_SEC + 1, 15, NOW_MS, BOOT_SEC)).toBe(false);
    expect(isStaleTelegramUpdate(nowSec - 2 * 3600, 15, NOW_MS, nowSec - 3 * 3600)).toBe(false);
  });

  it('0 disables the check entirely', () => {
    expect(isStaleTelegramUpdate(BOOT_SEC - 24 * 3600, 0, NOW_MS, BOOT_SEC)).toBe(false);
  });

  it('updates without a message date are never stale', () => {
    expect(isStaleTelegramUpdate(undefined, 15, NOW_MS, BOOT_SEC)).toBe(false);
  });
});

describe('isTelegramCallbackBacklog', () => {
  it('refuses taps on keyboards sent before this process started', () => {
    expect(isTelegramCallbackBacklog(BOOT_SEC - 1, BOOT_SEC)).toBe(true);
    expect(isTelegramCallbackBacklog(BOOT_SEC - 24 * 3600, BOOT_SEC)).toBe(true);
  });

  it('refuses a keyboard dated exactly at process start', () => {
    // One-second resolution makes this ambiguous: it could be a keyboard from
    // the process that crashed in that same second. Refuse rather than replay.
    expect(isTelegramCallbackBacklog(BOOT_SEC, BOOT_SEC)).toBe(true);
  });

  it('honours taps on keyboards this process sent, however late they arrive', () => {
    // The point of using the keyboard's origin instead of a clock window: a tap
    // queued behind an hour-long handler is still recognised as legitimate.
    expect(isTelegramCallbackBacklog(BOOT_SEC + 1, BOOT_SEC)).toBe(false);
    expect(isTelegramCallbackBacklog(nowSec - 3599, BOOT_SEC)).toBe(false);
  });

  it('refuses a tap whose message is unavailable', () => {
    // Inaccessible or too old to fetch — refusing costs a command, replaying
    // would switch the active character behind the user's back.
    expect(isTelegramCallbackBacklog(undefined, BOOT_SEC)).toBe(true);
  });
});
