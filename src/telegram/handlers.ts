import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Db } from '../db/sqlite.js';
import { randomUUID } from 'node:crypto';
import { splitForTelegram } from '../agent/finalizer.js';
import { getLinkedCharacter, listLinkedCharacters, setActiveCharacter } from '../eve/sso.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import { getOrCreateUser, type UserContext } from '../auth/user-resolver.js';
import {
  MAX_INPUT_LENGTH,
  createEveLoginLink,
  clearChatConversation,
  clearInFlightRequest,
  ensureChatSessionRow,
  evaluateChatRequestAllowance,
  hasInFlightRequest,
  activeRequestCount,
  insertSwitchNotification,
  isDuplicateInFlightRequest,
  normalizeAgentRuntimeError,
  normalizeUiCommandError,
  pickThinkingPhrase,
  refreshAndSummarize,
  rememberInFlightRequest,
  resolveThreadForChat,
  runAgentTurn,
} from '../chat/shared.js';
import { pickTelegramParseMode } from './formatting.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('telegram');

function buildUserContext(db: Db, ctx: Context): UserContext | null {
  if (!ctx.chat || !ctx.from) return null;
  const userId = getOrCreateUser(db, ctx.from.id, ctx.from.username, ctx.from.first_name);
  return { userId, chatId: ctx.chat.id };
}

export function registerHandlers(bot: Bot<Context>, db: Db): void {
  const commandsText =
    'Команды:\n' +
    '/eve_login — привязать персонажа EVE\n' +
    '/whoami — показать активного персонажа\n' +
    '/characters (/chars) — список привязанных персонажей\n' +
    '/use <id|name> — переключить активного персонажа\n' +
    '/market <type_id> — открыть рынок предмета в клиенте EVE\n' +
    '/info <target_id> — открыть окно информации в клиенте EVE\n' +
    '/clear (/reset) — очистить диалог\n' +
    '/help (/commands) — показать этот список';

  // /start
  bot.command('start', async (ctx) => {
    ensureSession(db, ctx);
    buildUserContext(db, ctx);
    await ctx.reply('EVE Agent готов. Пиши любой запрос по EVE Online.\n\n' + commandsText);
  });

  bot.command('help', async (ctx) => {
    ensureSession(db, ctx);
    await ctx.reply(commandsText);
  });

  bot.command('commands', async (ctx) => {
    ensureSession(db, ctx);
    await ctx.reply(commandsText);
  });

  // /eve_login and /eve-login
  const handleEveLogin = async (ctx: Context) => {
    ensureSession(db, ctx);
    const userCtx = buildUserContext(db, ctx);
    if (!ctx.chat || !userCtx) return;

    const url = createEveLoginLink(db, userCtx.userId, ctx.chat.id);
    await ctx.reply(`Открой ссылку для входа в EVE:\n${url}\n\nПосле привязки используй /characters для переключения.`);
  };

  bot.command('eve_login', handleEveLogin);
  bot.command('eve-login', handleEveLogin);

  // /whoami
  bot.command('whoami', async (ctx) => {
    ensureSession(db, ctx);
    const userCtx = buildUserContext(db, ctx);
    if (!ctx.chat || !userCtx) return;
    const linked = getLinkedCharacter(db, userCtx);
    if (!linked) {
      await ctx.reply('Персонаж не привязан. Используй /eve_login.');
      return;
    }
    await ctx.reply(
      `Активный персонаж: ${linked.characterName}\nID: ${linked.characterId}\nДоступов (scopes): ${linked.scopes.length}`,
    );
  });

  // /characters
  const handleCharacters = async (ctx: Context) => {
    ensureSession(db, ctx);
    const userCtx = buildUserContext(db, ctx);
    if (!ctx.chat || !userCtx) return;
    const linked = listLinkedCharacters(db, userCtx);
    if (linked.length === 0) {
      await ctx.reply('Персонажи не привязаны. Используй /eve_login.');
      return;
    }
    const lines = linked.map((entry) =>
      `${entry.isActive ? '* ' : '- '}${entry.characterName} (${entry.characterId})`,
    );

    const keyboard = new InlineKeyboard();
    for (const entry of linked) {
      if (!entry.isActive) {
        keyboard.text(`Переключить: ${entry.characterName}`, `switch_char:${entry.characterId}`).row();
      }
    }

    const hasButtons = linked.some((e) => !e.isActive);
    await ctx.reply(
      'Привязанные персонажи:\n' + lines.join('\n'),
      hasButtons ? { reply_markup: keyboard } : {},
    );
  };

  bot.command('characters', handleCharacters);
  bot.command('chars', handleCharacters);

  // Inline button callback: switch character
  bot.callbackQuery(/^switch_char:(\d+)$/, async (ctx) => {
    if (!ctx.from || !ctx.chat) {
      await ctx.answerCallbackQuery({ text: 'Ошибка.' });
      return;
    }

    const characterId = Number(ctx.match![1]);
    if (!Number.isFinite(characterId) || characterId <= 0) {
      await ctx.answerCallbackQuery({ text: 'Некорректный ID персонажа.' });
      return;
    }

    ensureSession(db, ctx);
    const userCtx = buildUserContext(db, ctx);
    if (!userCtx) {
      await ctx.answerCallbackQuery({ text: 'Пользователь не найден.' });
      return;
    }

    const switchOk = setActiveCharacter(db, userCtx, characterId);
    if (!switchOk) {
      await ctx.answerCallbackQuery({ text: 'Не удалось переключить персонажа.' });
      return;
    }

    const list = listLinkedCharacters(db, userCtx);
    const switched = list.find((e) => e.characterId === characterId);
    const charName = switched?.characterName ?? `ID ${characterId}`;

    await ctx.answerCallbackQuery({ text: `Переключено на ${charName}` });

    insertSwitchNotification(db, ctx.chat.id, characterId);

    const summaryText = await refreshAndSummarize(db, userCtx, charName, characterId);
    await ctx.reply(summaryText);
  });

  // /use <id|name>
  bot.command('use', async (ctx) => {
    ensureSession(db, ctx);
    const userCtx = buildUserContext(db, ctx);
    if (!ctx.chat || !ctx.message?.text || !userCtx) return;
    const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!arg) {
      await ctx.reply('Использование: /use <character_id|name>\nСмотри /characters.');
      return;
    }

    const list = listLinkedCharacters(db, userCtx);
    if (list.length === 0) {
      await ctx.reply('Персонажи не привязаны. Используй /eve_login.');
      return;
    }

    const byId = Number(arg);
    let match: typeof list[number] | null = null;
    if (Number.isFinite(byId) && byId > 0) {
      match = list.find((entry) => entry.characterId === byId) ?? null;
    } else {
      const normalized = arg.toLowerCase();
      const matches = list.filter((entry) => entry.characterName.toLowerCase() === normalized);
      if (matches.length === 1) {
        match = matches[0];
      } else if (matches.length > 1) {
        const options = matches.map((entry) => `${entry.characterName} (${entry.characterId})`).join('\n');
        await ctx.reply(`Несколько совпадений для "${arg}". Используй /use <id>:\n${options}`);
        return;
      }
    }

    if (!match) {
      await ctx.reply(`Персонаж не найден: ${arg}. Смотри /characters.`);
      return;
    }

    const ok = setActiveCharacter(db, userCtx, match.characterId);
    if (!ok) {
      await ctx.reply('Не удалось переключить персонажа. Смотри /characters и выбери корректный ID.');
      return;
    }

    insertSwitchNotification(db, ctx.chat.id, match.characterId);

    const pendingMsg = await ctx.reply(`Переключаю на ${match.characterName}...`);
    const summaryText = await refreshAndSummarize(db, userCtx, match.characterName, match.characterId);
    try {
      await ctx.api.editMessageText(ctx.chat.id, pendingMsg.message_id, summaryText);
    } catch {
      await ctx.reply(summaryText);
    }
  });

  bot.command('market', async (ctx) => {
    ensureSession(db, ctx);
    const userCtx = buildUserContext(db, ctx);
    if (!ctx.chat || !ctx.message?.text || !userCtx) return;
    const typeId = parsePositiveCommandArg(ctx.message.text);
    if (typeId === null) {
      await ctx.reply('Использование: /market <type_id>');
      return;
    }

    await getEveCapabilities(db, 'telegram_market', userCtx);
    const result = await callEsiOperation(db, 'post_ui_openwindow_marketdetails', { type_id: typeId }, userCtx);

    if (!result.ok) {
      await ctx.reply(normalizeUiCommandError(result.error));
      return;
    }
    await ctx.reply(`Открыл рынок в клиенте для type_id \`${typeId}\`.`);
  });

  bot.command('info', async (ctx) => {
    ensureSession(db, ctx);
    const userCtx = buildUserContext(db, ctx);
    if (!ctx.chat || !ctx.message?.text || !userCtx) return;
    const targetId = parsePositiveCommandArg(ctx.message.text);
    if (targetId === null) {
      await ctx.reply('Использование: /info <target_id>');
      return;
    }

    await getEveCapabilities(db, 'telegram_info', userCtx);
    const result = await callEsiOperation(db, 'post_ui_openwindow_information', { target_id: targetId }, userCtx);

    if (!result.ok) {
      await ctx.reply(normalizeUiCommandError(result.error));
      return;
    }
    await ctx.reply(`Открыл окно информации в клиенте для target_id \`${targetId}\`.`);
  });

  // /reset
  bot.command('reset', async (ctx) => {
    await clearConversation(db, ctx);
  });

  // /clear (alias)
  bot.command('clear', async (ctx) => {
    await clearConversation(db, ctx);
  });

  // Non-text messages -- inform user
  bot.on('message', async (ctx, next) => {
    if (!ctx.message?.text) {
      await ctx.reply('Понимаю только текстовые сообщения.');
      return;
    }
    await next();
  });

  // Text messages -> agent runtime
  bot.on('message:text', async (ctx) => {
    ensureSession(db, ctx);

    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    const userCtx = buildUserContext(db, ctx);
    if (!userCtx) return;

    // Skip empty/whitespace messages
    if (!text) return;

    // Limit input length to prevent excessive token usage
    if (text.length > MAX_INPUT_LENGTH) {
      await ctx.reply(`Сообщение слишком длинное (${text.length} символов). Максимум: ${MAX_INPUT_LENGTH}.`);
      return;
    }

    const allowance = evaluateChatRequestAllowance({
      chatId,
      userId: userCtx.userId,
      hasActiveRequest: hasInFlightRequest(chatId),
      activeRequestCount: activeRequestCount(),
    });
    if (!allowance.ok) {
      await ctx.reply(allowance.message ?? 'Запрос отклонён.');
      return;
    }

    const threadId = resolveThreadForChat(db, chatId, userCtx);

    if (isDuplicateInFlightRequest(chatId, threadId, text)) {
      await ctx.reply('Такой же запрос уже обрабатывается.');
      return;
    }

    const requestToken = randomUUID();
    rememberInFlightRequest(chatId, threadId, text, requestToken);

    // Send EVE-flavored "thinking" placeholder. Guarded: a failed reply must
    // not leak the in-flight entry, or the chat wedges until restart.
    const thinkingMsg = await ctx.reply(pickThinkingPhrase()).catch(() => null);

    try {
      const stopTyping = startTyping(ctx);
      try {
        log.info('message chat_id=%d user_id=%d len=%d', chatId, userCtx.userId, text.length);
        const cleaned = await runAgentTurn(db, threadId, userCtx, text);
        // Delete thinking placeholder, then send real response
        if (thinkingMsg) await ctx.api.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
        await replyChunks(ctx, cleaned);
      } finally {
        stopTyping();
      }
    } catch (err) {
      log.error('agent error: %s', err instanceof Error ? err.message : String(err));
      if (thinkingMsg) await ctx.api.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
      await ctx.reply(normalizeAgentRuntimeError(err)).catch(() => {});
    } finally {
      clearInFlightRequest(chatId, requestToken);
    }
  });
}

export { isDuplicateInFlightRequest, rememberInFlightRequest, clearInFlightRequest } from '../chat/shared.js';

function ensureSession(db: Db, ctx: Context): void {
  if (!ctx.chat) return;
  ensureChatSessionRow(db, ctx.chat.id, ctx.from?.username ?? '');
}

async function clearConversation(db: Db, ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const cleared = clearChatConversation(db, ctx.chat.id);
  log.info('chat=%d cleared %d threads', ctx.chat.id, cleared);
  await ctx.reply('Диалог очищен.');
}

// Headroom for the "Часть N/M\n" prefix so prefixed chunks stay under 4096.
const CHUNK_PREFIX_HEADROOM = 24;

async function replyChunks(ctx: Context, text: string): Promise<void> {
  const chunks = splitForTelegram(text, 4096 - CHUNK_PREFIX_HEADROOM);
  const total = chunks.length;
  for (let i = 0; i < total; i += 1) {
    const prefix = total > 1 ? `Часть ${i + 1}/${total}\n` : '';
    await replyFormatted(ctx, prefix + chunks[i]);
  }
}

async function replyFormatted(ctx: Context, text: string): Promise<void> {
  try {
    const parseMode = pickTelegramParseMode(text);
    await ctx.reply(text, { parse_mode: parseMode });
  } catch {
    await ctx.reply(text);
  }
}

function startTyping(ctx: Context): () => void {
  const chatId = ctx.chat?.id;
  if (!chatId) return () => {};

  const send = () => ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
  send();
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

function parsePositiveCommandArg(text: string): number | null {
  const arg = text.split(' ').slice(1).join(' ').trim();
  if (!arg) return null;
  const num = Number(arg);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}
