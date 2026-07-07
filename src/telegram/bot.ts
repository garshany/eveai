import { Bot, Context } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { isTelegramUserAllowed } from './access.js';
import { registerHandlers } from './handlers.js';

export function createBot(db: Db): Bot<Context> {
  const timeoutSeconds = parseTimeoutSeconds(process.env.TELEGRAM_TIMEOUT_SECONDS);
  const proxyUrl = process.env.TELEGRAM_PROXY || null;
  const proxyAgent = proxyUrl ? createProxyAgent(proxyUrl) : null;
  if (proxyUrl && !proxyAgent) {
    console.warn('[bot] Unsupported TELEGRAM_PROXY scheme. Use http(s):// or socks5h://');
  }
  if (proxyAgent) {
    console.log(`[bot] Telegram proxy enabled: ${redactProxyUrl(proxyUrl!)}`);
  }

  const client: { timeoutSeconds: number; baseFetchConfig?: { agent: unknown } } = {
    timeoutSeconds,
  };
  if (proxyAgent) {
    client.baseFetchConfig = { agent: proxyAgent };
  }

  const bot = new Bot(config.telegram.botToken, { client });

  // Private chat only -- reject group chats to prevent data leaks
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      await ctx.reply('This bot only works in private chats.');
      return;
    }
    await next();
  });

  // Optional allowlist. `0` means "allow any private Telegram user".
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!isTelegramUserAllowed(userId, config.telegram.allowedUserId)) {
      console.warn(`[bot] Access denied for user_id=${userId ?? 'unknown'}`);
      await ctx.reply('Access denied.');
      return;
    }
    await next();
  });

  registerHandlers(bot, db);

  bot.api.setMyCommands([
    { command: 'start', description: 'Начать' },
    { command: 'help', description: 'Список команд' },
    { command: 'commands', description: 'Список команд' },
    { command: 'eve_login', description: 'Привязать персонажа EVE' },
    { command: 'whoami', description: 'Показать активного персонажа' },
    { command: 'characters', description: 'Список персонажей' },
    { command: 'use', description: 'Переключить активного персонажа' },
    { command: 'clear', description: 'Очистить диалог' },
  ]).catch((err) => {
    console.warn('[bot] setMyCommands failed: %s', err instanceof Error ? err.message : String(err));
  });

  bot.catch((err) => {
    console.error('[bot] Error:', err.message);
  });

  return bot;
}
function parseTimeoutSeconds(raw: string | undefined): number {
  if (!raw) return 20;
  const val = Number(raw);
  if (!Number.isFinite(val) || val <= 0) return 20;
  return Math.round(val);
}

function createProxyAgent(proxyUrl: string): unknown | null {
  if (proxyUrl.startsWith('socks')) {
    return new SocksProxyAgent(proxyUrl);
  }
  if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
    return new HttpsProxyAgent(proxyUrl);
  }
  return null;
}

function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[invalid proxy URL]';
  }
}
