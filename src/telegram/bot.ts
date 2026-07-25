import { Bot, Context } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { isTelegramUserAllowed } from './access.js';
import { registerHandlers } from './handlers.js';
import { claimTelegramUpdate, pruneProcessedUpdates } from './update-dedup.js';

export const TELEGRAM_COMMANDS = [
  { command: 'start', description: 'Начать' },
  { command: 'help', description: 'Список команд' },
  { command: 'commands', description: 'Список команд' },
  { command: 'eve_login', description: 'Привязать персонажа EVE' },
  { command: 'whoami', description: 'Показать активного персонажа' },
  { command: 'characters', description: 'Список персонажей' },
  { command: 'use', description: 'Переключить активного персонажа' },
  { command: 'version', description: 'Проверить обновления проекта' },
  { command: 'update', description: 'Проверить обновления проекта' },
  { command: 'clear', description: 'Очистить диалог' },
];

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
      console.warn('[bot] Access denied for Telegram user');
      await ctx.reply('Access denied.');
      return;
    }
    await next();
  });

  // Staleness gate: pending updates are redelivered after a restart (we no
  // longer drop them by default), but a backlog from a long outage must not be
  // replayed — answering day-old questions confuses, and replaying stale
  // destructive commands (/clear) is worse. Applies ONLY to updates sent
  // before this process started: sequential long polling can delay a LIVE
  // message behind a long turn, and that must never be skipped. 0 disables.
  // Floor to whole seconds: Telegram dates are integer Unix seconds, so a
  // fractional boot time would rank a keyboard sent during the startup second
  // as older than the process and reject taps on it.
  const startedAtUnixSeconds = Math.floor(Date.now() / 1000);
  bot.use(async (ctx, next) => {
    // Callback queries carry no press timestamp — `ctx.callbackQuery.message`
    // is dated when the BOT sent the keyboard, not when the button was tapped —
    // so the age check below cannot see them. Telegram redelivers pending
    // callbacks after a restart, and replaying one silently switches the active
    // character. What CAN be decided exactly is which keyboard the tap belongs
    // to: a redelivered tap necessarily references a message this process did
    // not send. Those are refused; keyboards sent by the running process cannot
    // be backlog and pass through.
    if (ctx.callbackQuery) {
      const keyboardSentAt = ctx.callbackQuery.message?.date;
      if (isTelegramCallbackBacklog(keyboardSentAt, startedAtUnixSeconds)) {
        console.warn(`[bot] refusing pre-boot callback: chat=${ctx.chat?.id} data=${ctx.callbackQuery.data ?? 'none'}`);
        await ctx.answerCallbackQuery({
          text: 'Бот перезапустился — отправь команду заново, кнопки этого сообщения устарели.',
          show_alert: true,
        }).catch(() => {});
        return;
      }
    } else {
      const sentAt = ctx.message?.date; // unix seconds
      if (isStaleTelegramUpdate(sentAt, config.telegram.maxUpdateAgeMinutes, Date.now(), startedAtUnixSeconds)) {
        console.warn(`[bot] skipping stale pre-boot update: chat=${ctx.chat?.id} age=${Math.round(Date.now() / 1000 - (sentAt ?? 0))}s`);
        return;
      }
    }

    // Keeping pending updates means an update handled just before the process
    // died is redelivered — its offset was never confirmed. Claim it first so
    // the answer and its write tools do not run a second time.
    if (!claimTelegramUpdate(db, ctx.update.update_id)) {
      console.warn(`[bot] skipping already-handled update=${ctx.update.update_id} chat=${ctx.chat?.id}`);
      return;
    }

    await next();
  });

  // One sweep at boot keeps the dedup table from carrying dead rows forever in
  // a bot that restarts more often than it reaches the in-flight prune cadence.
  try {
    pruneProcessedUpdates(db);
  } catch (err) {
    console.warn('[bot] pruning processed updates failed: %s', err instanceof Error ? err.message : String(err));
  }

  registerHandlers(bot, db);

  bot.api.setMyCommands(TELEGRAM_COMMANDS).catch((err) => {
    console.warn('[bot] setMyCommands failed: %s', err instanceof Error ? err.message : String(err));
  });

  bot.catch((err) => {
    console.error('[bot] Error:', err.message);
  });

  return bot;
}
/**
 * True when a redelivered PRE-BOOT update is older than the configured window.
 * Updates sent after the process started are never stale — long polling is
 * sequential, so a live message can legitimately wait behind a long agent turn
 * longer than the window. maxAgeMinutes 0 disables the check; updates without
 * a date are never stale (callback queries carry no message date).
 */
export function isStaleTelegramUpdate(
  sentAtUnixSeconds: number | undefined,
  maxAgeMinutes: number,
  nowMs: number,
  startedAtUnixSeconds: number,
): boolean {
  if (maxAgeMinutes <= 0 || !sentAtUnixSeconds) return false;
  if (sentAtUnixSeconds >= startedAtUnixSeconds) return false;
  return nowMs / 1000 - sentAtUnixSeconds > maxAgeMinutes * 60;
}

/**
 * True when a button tap may be a redelivered pre-boot callback.
 *
 * A queued callback always points at a keyboard that existed before the
 * restart, so comparing the keyboard's send time with process start decides it
 * exactly — no clock window, no assumption about how fast the backlog drains,
 * and nothing consumed from the update queue (peeking it with a negative
 * `getUpdates` offset would confirm and destroy the rest of the backlog).
 *
 * A missing message (inaccessible, or older than Telegram keeps) is treated as
 * pre-boot: refusing costs the user one command, replaying corrupts state.
 *
 * The cost is that a restart retires older keyboards: tapping one answers with
 * "send the command again" instead of acting. That is deliberate — a tap can
 * only be honoured when its keyboard provably belongs to this process.
 */
export function isTelegramCallbackBacklog(
  keyboardSentAtUnixSeconds: number | undefined,
  startedAtUnixSeconds: number,
): boolean {
  if (keyboardSentAtUnixSeconds === undefined) return true;
  // Equality is ambiguous — Telegram dates have one-second resolution, so a
  // keyboard sent by the previous process just before a same-second restart
  // looks identical to one this process sent on boot. Refuse it: the cost is a
  // repeated command inside a one-second window, the alternative is a replayed
  // state change.
  return keyboardSentAtUnixSeconds <= startedAtUnixSeconds;
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
