import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverOutbound,
  isOutboundAvailable,
  isPermanentOutboundFailure,
  registerDiscordOutbound,
  registerTelegramOutbound,
  resetOutboundForTests,
} from '../../src/messaging/outbound.js';

describe('durable outbound delivery', () => {
  afterEach(() => {
    resetOutboundForTests();
  });

  it('awaits the sender selected by the internal chat lane', async () => {
    const telegram = vi.fn(async () => {});
    const discord = vi.fn(async () => {});
    registerTelegramOutbound(telegram);
    registerDiscordOutbound(discord);

    expect(isOutboundAvailable(42)).toBe(true);
    expect(isOutboundAvailable(-42)).toBe(true);

    await deliverOutbound(42, 'telegram message');
    await deliverOutbound(-42, 'discord message');

    expect(telegram).toHaveBeenCalledWith(42, 'telegram message');
    expect(discord).toHaveBeenCalledWith(-42, 'discord message');
  });

  it('rejects when the target platform is not running', async () => {
    expect(isOutboundAvailable(42)).toBe(false);
    expect(isOutboundAvailable(-42)).toBe(false);
    await expect(deliverOutbound(42, 'message')).rejects.toThrow(
      'telegram outbound sender is not registered',
    );
  });

  it('propagates platform delivery failure to the durable producer', async () => {
    registerDiscordOutbound(async () => {
      throw new Error('gateway unavailable');
    });

    await expect(deliverOutbound(-42, 'message')).rejects.toThrow('gateway unavailable');
  });

  it('classifies terminal Telegram and Discord recipient failures', async () => {
    registerTelegramOutbound(async () => {
      throw Object.assign(new Error('bot was blocked by the user'), { error_code: 403 });
    });
    registerDiscordOutbound(async () => {
      throw Object.assign(new Error('Cannot send messages to this user'), { code: 50_007 });
    });

    const telegramError = await deliverOutbound(42, 'message').catch((error: unknown) => error);
    const discordError = await deliverOutbound(-42, 'message').catch((error: unknown) => error);

    expect(isPermanentOutboundFailure(telegramError)).toBe(true);
    expect(isPermanentOutboundFailure(discordError)).toBe(true);
  });

  it('classifies a missing durable Discord DM mapping as terminal', async () => {
    registerDiscordOutbound(async () => {
      throw new Error('No Discord channel mapped for chat_key=-42');
    });

    const error = await deliverOutbound(-42, 'message').catch((caught: unknown) => caught);

    expect(isPermanentOutboundFailure(error)).toBe(true);
  });

  it('keeps rate limits and transport failures retryable', async () => {
    registerTelegramOutbound(async () => {
      throw Object.assign(new Error('Too Many Requests'), { error_code: 429 });
    });

    const error = await deliverOutbound(42, 'message').catch((caught: unknown) => caught);

    expect(isPermanentOutboundFailure(error)).toBe(false);
  });
});
