import { Bot, Context } from 'grammy';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { registerHandlers } from './handlers.js';

export function createBot(db: Db): Bot<Context> {
  const bot = new Bot(config.telegram.botToken);

  // Single-user guard
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== config.telegram.allowedUserId) {
      await ctx.reply('Access denied.');
      return;
    }
    await next();
  });

  registerHandlers(bot, db);

  bot.catch((err) => {
    console.error('[bot] Error:', err.message);
  });

  return bot;
}
