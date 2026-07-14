import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 0 },
    discord: { botToken: 'test', allowedUserId: '' },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    web: { baseUrl: 'http://localhost:3000' },
  },
}));

describe('platform update command surfaces', () => {
  it('registers version and update aliases in Telegram and Discord', async () => {
    const { TELEGRAM_COMMANDS } = await import('../../src/telegram/bot.js');
    const { DISCORD_SLASH_COMMANDS } = await import('../../src/discord/bot.js');
    expect(TELEGRAM_COMMANDS.map((entry) => entry.command)).toEqual(expect.arrayContaining(['version', 'update']));
    expect(DISCORD_SLASH_COMMANDS.map((entry) => entry.toJSON().name)).toEqual(expect.arrayContaining(['version', 'update']));
  });
});
