import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { randomUUID } from 'node:crypto';
import { handleAgentMessage } from '../agent/executor.js';
import { finalizeThreadMessage, splitForTelegram } from '../agent/finalizer.js';
import { ALL_REQUESTED_SCOPES } from '../eve/scopes.js';
import { compactThreadIfNeeded } from '../agent/compact.js';
import { getLinkedCharacter, listLinkedCharacters, setActiveCharacter } from '../eve/sso.js';
import { refreshUserProfile, readUserProfile } from '../eve/user-profile.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import { getOrCreateUser, type UserContext } from '../auth/user-resolver.js';
import { createHandoffToken } from '../auth/handoff.js';
import { createAuthRequestToken, protectLegacyOauthState } from '../auth/auth-request.js';

const inFlightRequests = new Map<number, {
  token: string;
  threadId: string;
  text: string;
  startedAt: number;
}>();
const DUPLICATE_REQUEST_WINDOW_MS = 30_000;

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
    '/web — открыть веб-панель управления\n' +
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

    // Store auth request for CSRF validation on callback
    const state = createAuthRequestToken(db, 'eve_sso', userCtx.userId, {
      chatId: ctx.chat.id,
      ttlSeconds: 600,
    });

    // Also store in telegram_sessions for backward compat
    db.prepare(
      'UPDATE telegram_sessions SET oauth_state = ? WHERE chat_id = ?',
    ).run(protectLegacyOauthState(state), ctx.chat.id);

    const scopes = ALL_REQUESTED_SCOPES.join(' ');
    const url = new URL('https://login.eveonline.com/v2/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.eve.callbackUrl);
    url.searchParams.set('client_id', config.eve.clientId);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);

    await ctx.reply(`Открой ссылку для входа в EVE:\n${url.toString()}\n\nПосле привязки используй /characters для переключения.`);
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

  // /web -- generate handoff token and send inline button
  bot.command('web', async (ctx) => {
    ensureSession(db, ctx);
    const userCtx = buildUserContext(db, ctx);
    if (!ctx.chat || !userCtx) return;

    const token = createHandoffToken(db, userCtx.userId, ctx.chat.id);
    const url = `${config.web.baseUrl}/auth/tg-handoff?token=${token}`;

    const keyboard = new InlineKeyboard().url('Открыть панель', url);
    await ctx.reply('Открой веб-панель для управления персонажами:', { reply_markup: keyboard });
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
    const MAX_INPUT_LENGTH = 2000;
    if (text.length > MAX_INPUT_LENGTH) {
      await ctx.reply(`Сообщение слишком длинное (${text.length} символов). Максимум: ${MAX_INPUT_LENGTH}.`);
      return;
    }

    const activeCharacter = getLinkedCharacter(db, userCtx);
    const activeCharacterId = activeCharacter?.characterId ?? null;

    // Get or create thread per character
    let thread: { thread_id: string } | undefined;
    if (activeCharacterId) {
      thread = db.prepare(
        'SELECT thread_id FROM agent_threads WHERE chat_id = ? AND character_id = ? ORDER BY created_at DESC LIMIT 1',
      ).get(chatId, activeCharacterId) as { thread_id: string } | undefined;
    } else {
      thread = db.prepare(
        'SELECT thread_id FROM agent_threads WHERE chat_id = ? AND character_id IS NULL ORDER BY created_at DESC LIMIT 1',
      ).get(chatId) as { thread_id: string } | undefined;
    }

    if (!thread) {
      const threadId = randomUUID();
      db.prepare('INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id) VALUES (?, ?, ?, ?)').run(
        threadId, chatId, activeCharacterId, userCtx.userId,
      );
      thread = { thread_id: threadId };
    }

    if (isDuplicateInFlightRequest(chatId, thread.thread_id, text)) {
      await ctx.reply('Такой же запрос уже обрабатывается.');
      return;
    }

    const requestToken = randomUUID();
    rememberInFlightRequest(chatId, thread.thread_id, text, requestToken);

    // Store user message
    db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(thread.thread_id, 'user', text);

    // Send EVE-flavored "thinking" placeholder
    const thinkingMsg = await ctx.reply(pickThinkingPhrase());

    try {
      const stopTyping = startTyping(ctx);
      try {
        void maybeRefreshUserProfile(db, userCtx);
        console.log(`[handler] message chat_id=${chatId} user_id=${userCtx.userId} len=${text.length}`);
        const response = await handleAgentMessage(db, thread.thread_id, userCtx, text);
        const cleaned = finalizeThreadMessage(db, thread.thread_id, response);
        // Delete thinking placeholder, then send real response
        await ctx.api.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
        await replyChunks(ctx, cleaned);
        // Background: update summary for cold start fallback (proxy restart, >30 days, etc.)
        void compactThreadIfNeeded(db, thread.thread_id).catch(() => {});
      } finally {
        stopTyping();
      }
    } catch (err) {
      console.error('[handler] Agent error:', err);
      await ctx.api.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
      await ctx.reply(normalizeAgentRuntimeError(err));
    } finally {
      clearInFlightRequest(chatId, requestToken);
    }
  });
}

export function isDuplicateInFlightRequest(chatId: number, threadId: string, text: string, now = Date.now()): boolean {
  const current = inFlightRequests.get(chatId);
  if (!current) return false;
  if (current.threadId !== threadId) return false;
  if (current.text !== text) return false;
  return now - current.startedAt < DUPLICATE_REQUEST_WINDOW_MS;
}

export function rememberInFlightRequest(chatId: number, threadId: string, text: string, token: string, startedAt = Date.now()): void {
  inFlightRequests.set(chatId, {
    token,
    threadId,
    text,
    startedAt,
  });
}

export function clearInFlightRequest(chatId: number, token?: string): void {
  const current = inFlightRequests.get(chatId);
  if (!current) return;
  if (token && current.token !== token) return;
  inFlightRequests.delete(chatId);
}

function ensureSession(db: Db, ctx: Context): void {
  if (!ctx.chat) return;
  db.prepare(
    `INSERT INTO telegram_sessions (chat_id, username, last_seen_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, last_seen_at = datetime('now')`,
  ).run(ctx.chat.id, ctx.from?.username ?? '');
}

async function clearConversation(db: Db, ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const threads = db.prepare('SELECT thread_id FROM agent_threads WHERE chat_id = ?').all(chatId) as Array<{ thread_id: string }>;
  db.prepare('DELETE FROM thread_summaries WHERE thread_id IN (SELECT thread_id FROM agent_threads WHERE chat_id = ?)').run(chatId);
  db.prepare('DELETE FROM messages WHERE thread_id IN (SELECT thread_id FROM agent_threads WHERE chat_id = ?)').run(chatId);
  db.prepare('DELETE FROM agent_threads WHERE chat_id = ?').run(chatId);
  console.log('[clear] chat=%d cleared %d threads (proxy sessions expire via TTL)', chatId, threads.length);
  await ctx.reply('Диалог очищен.');
}

async function replyChunks(ctx: Context, text: string): Promise<void> {
  const chunks = splitForTelegram(text);
  const total = chunks.length;
  for (let i = 0; i < total; i += 1) {
    const prefix = total > 1 ? `Часть ${i + 1}/${total}\n` : '';
    await replyFormatted(ctx, prefix + chunks[i]);
  }
}

async function replyFormatted(ctx: Context, text: string): Promise<void> {
  try {
    const parseMode = text.includes('<tg-spoiler>') || text.includes('<b>') || text.includes('<a href=')
      ? 'HTML'
      : 'Markdown';
    await ctx.reply(text, { parse_mode: parseMode });
  } catch {
    await ctx.reply(text);
  }
}

async function maybeRefreshUserProfile(db: Db, ctx: UserContext): Promise<void> {
  const refreshSeconds = config.userProfile.refreshSeconds;
  if (!refreshSeconds || refreshSeconds <= 0) return;
  const profile = readUserProfile(db, ctx);
  if (!profile) {
    void refreshUserProfile(db, ctx).catch(() => {});
    return;
  }
  const match = /^Updated:\s*(.+)$/m.exec(profile);
  if (!match) {
    void refreshUserProfile(db, ctx).catch(() => {});
    return;
  }
  const updatedAt = Date.parse(match[1]);
  if (!Number.isFinite(updatedAt)) {
    void refreshUserProfile(db, ctx).catch(() => {});
    return;
  }
  const ageSeconds = (Date.now() - updatedAt) / 1000;
  if (ageSeconds >= refreshSeconds) {
    void refreshUserProfile(db, ctx).catch(() => {});
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

const EVE_THINKING_PHRASES = [
  'Качаю Cybernetics V...',
  'Лью Large Skill Injector...',
  'Жду ответа от Aura...',
  'Сканирую сигнатуры...',
  'Запрашиваю данные с Jita 4-4...',
  'Прогреваю варп-двигатель...',
  'Калибрую D-Scan...',
  'Подключаюсь к CONCORD...',
  'Дешифрую данные Sleepers...',
  'Загружаю карго...',
  'Оптимизирую фиттинг...',
  'Анализирую killboard...',
  'Рассчитываю орбиту...',
  'Взламываю relic-контейнер...',
  'Запускаю дроны...',
  'Активирую клоаку...',
  'Перегружаю хардинеры...',
  'Обновляю маркет-ордера...',
  'Прыгаю через гейт...',
  'Докую в цитадель...',
];

function pickThinkingPhrase(): string {
  return EVE_THINKING_PHRASES[Math.floor(Math.random() * EVE_THINKING_PHRASES.length)];
}

const PROFILE_REFRESH_TIMEOUT_MS = 10_000;

async function refreshAndSummarize(
  db: Db,
  userCtx: UserContext,
  charName: string,
  characterId: number,
): Promise<string> {
  let profileContent: string | null = null;
  try {
    const result = await Promise.race([
      refreshUserProfile(db, userCtx),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROFILE_REFRESH_TIMEOUT_MS)),
    ]);
    if (result && result.ok) {
      profileContent = readUserProfile(db, userCtx);
    }
  } catch {
    // profile will refresh later on next message
  }

  if (!profileContent) {
    return `Активный персонаж: ${charName} (${characterId}).`;
  }

  return formatProfileSummary(profileContent, charName, characterId);
}

function formatProfileSummary(profile: string, characterName: string, characterId: number): string {
  const lines: string[] = [`Активный персонаж: ${characterName} (${characterId})`];

  const corpMatch = /^- Corporation:\s*(.+)$/m.exec(profile);
  if (corpMatch) lines.push(`Корп: ${corpMatch[1]}`);

  const allianceMatch = /^- Alliance:\s*(.+)$/m.exec(profile);
  if (allianceMatch) lines.push(`Альянс: ${allianceMatch[1]}`);

  const systemMatch = /^- System:\s*(.+)$/m.exec(profile);
  if (systemMatch) lines.push(`Система: ${systemMatch[1]}`);

  const shipMatch = /^- Ship:\s*(.+)$/m.exec(profile);
  if (shipMatch) lines.push(`Корабль: ${shipMatch[1]}`);

  const walletMatch = /^- Balance ISK:\s*(.+)$/m.exec(profile);
  if (walletMatch) lines.push(`ISK: ${walletMatch[1]}`);

  return lines.join('\n');
}

function insertSwitchNotification(db: Db, chatId: number, characterId: number): void {
  const thread = db.prepare(
    'SELECT thread_id FROM agent_threads WHERE chat_id = ? AND character_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(chatId, characterId) as { thread_id: string } | undefined;

  if (!thread) return;

  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(
    thread.thread_id,
    'user',
    '[System] Пользователь переключился на этого персонажа.',
  );
}

function normalizeUiCommandError(error: string | null): string {
  const text = (error ?? '').trim();
  if (!text) {
    return 'Не удалось выполнить команду в клиенте EVE.';
  }
  if (text.includes('No EVE character linked') || text.includes('/eve_login')) {
    return 'Персонаж не привязан или сессия истекла. Используй /eve_login.';
  }
  if (text.includes('Missing scopes')) {
    return 'Для этой команды клиент EVE не дал нужный доступ. Перелогинься через /eve_login.';
  }
  return `Не удалось выполнить команду в клиенте EVE: ${text}`;
}

function normalizeAgentRuntimeError(err: unknown): string {
  const combined = collectErrorText(err).toLowerCase();

  if (
    combined.includes('apiconnectionerror')
    || combined.includes('fetch failed')
    || combined.includes('econnrefused')
    || combined.includes('connect etimedout')
    || combined.includes('enotfound')
  ) {
    return 'LLM backend сейчас недоступен. Попробуй ещё раз чуть позже.';
  }

  if (combined.includes('429') || combined.includes('rate limit')) {
    return 'LLM backend перегружен или упёрся в лимит. Попробуй ещё раз чуть позже.';
  }

  if (combined.includes('401') || combined.includes('403') || combined.includes('authentication')) {
    return 'LLM backend отклонил авторизацию. Проверь настройки доступа.';
  }

  return 'Внутренняя ошибка. Попробуй ещё раз.';
}

function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || seen.has(item)) continue;
    seen.add(item);

    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }

    if (item instanceof Error) {
      parts.push(item.name, item.message);
      if ('cause' in item) {
        queue.push((item as Error & { cause?: unknown }).cause);
      }
      continue;
    }

    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (typeof record.message === 'string') parts.push(record.message);
      if (typeof record.code === 'string') parts.push(record.code);
      if (typeof record.type === 'string') parts.push(record.type);
      if ('cause' in record) queue.push(record.cause);
    }
  }

  return parts.join(' ');
}
