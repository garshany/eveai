import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type DMChannel,
  type Interaction,
  type Message,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { getLinkedCharacter, listLinkedCharacters, setActiveCharacter } from '../eve/sso.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import type { UserContext } from '../auth/user-resolver.js';
import {
  MAX_INPUT_LENGTH,
  createEveLoginLink,
  clearChatConversation,
  clearInFlightRequest,
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
import { buildEveSsoSetupGuide, isEveSsoConfigured } from '../eve/eve-login.js';
import {
  ensureDiscordSession,
  getDiscordChannelId,
  getOrCreateDiscordUser,
  isDiscordUserAllowed,
} from './session.js';
import { MAX_DISCORD_LENGTH, splitForDiscord } from './format.js';
import { createLogger } from '../observability/logger.js';
import { checkForProjectUpdate } from '../update/check.js';
import { formatUpdateStatus } from '../update/format.js';

const log = createLogger('discord');

const COMMANDS_TEXT =
  'Команды:\n' +
  '/eve_login — привязать персонажа EVE\n' +
  '/whoami — показать активного персонажа\n' +
  '/characters — список привязанных персонажей\n' +
  '/use <id|name> — переключить активного персонажа\n' +
  '/market <type_id> — открыть рынок предмета в клиенте EVE\n' +
  '/info <target_id> — открыть окно информации в клиенте EVE\n' +
  '/version (/update) — проверить обновления проекта\n' +
  '/clear — очистить диалог\n' +
  '/help — показать этот список\n\n' +
  'Любое обычное сообщение в личке — запрос к EVE-агенту.';

export const DISCORD_SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('start').setDescription('Начать работу с EVE-агентом'),
  new SlashCommandBuilder().setName('help').setDescription('Список команд'),
  new SlashCommandBuilder().setName('eve_login').setDescription('Привязать персонажа EVE'),
  new SlashCommandBuilder().setName('whoami').setDescription('Показать активного персонажа'),
  new SlashCommandBuilder().setName('characters').setDescription('Список привязанных персонажей'),
  new SlashCommandBuilder().setName('use').setDescription('Переключить активного персонажа')
    .addStringOption((opt) => opt.setName('character').setDescription('ID или имя персонажа').setRequired(true)),
  new SlashCommandBuilder().setName('market').setDescription('Открыть рынок предмета в клиенте EVE')
    .addIntegerOption((opt) => opt.setName('type_id').setDescription('ID предмета').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('info').setDescription('Открыть окно информации в клиенте EVE')
    .addIntegerOption((opt) => opt.setName('target_id').setDescription('ID цели').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('version').setDescription('Проверить обновления проекта'),
  new SlashCommandBuilder().setName('update').setDescription('Проверить обновления проекта'),
  new SlashCommandBuilder().setName('clear').setDescription('Очистить диалог'),
].map((builder) => builder.setContexts(
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
));

type SessionContext = {
  userCtx: UserContext;
  chatKey: number;
};

export function createDiscordBot(db: Db): Client {
  const client = new Client({
    // DM-only bot: no guild message intents, and the privileged MessageContent
    // intent is NOT needed — Discord always delivers content in DMs.
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
    ],
    // DM channels/messages arrive as partials without these. Partials.Channel
    // also makes interaction.channel resolvable in DM slash commands.
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (ready) => {
    log.info('logged in as %s', ready.user.tag);
    ready.application.commands.set(DISCORD_SLASH_COMMANDS.map((cmd) => cmd.toJSON())).catch((err) => {
      log.warn('slash command registration failed: %s', err instanceof Error ? err.message : String(err));
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(db, message).catch((err) => {
      log.error('message handler error: %s', err instanceof Error ? err.message : String(err));
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(db, interaction).catch((err) => {
      log.error('interaction handler error: %s', err instanceof Error ? err.message : String(err));
    });
  });

  client.on(Events.Error, (err) => {
    log.error('client error: %s', err.message);
  });

  return client;
}

function resolveSessionContext(
  db: Db,
  input: { discordUserId: string; username?: string; displayName?: string; channelId: string },
): SessionContext {
  const userId = getOrCreateDiscordUser(db, input.discordUserId, input.username, input.displayName);
  const chatKey = ensureDiscordSession(db, {
    channelId: input.channelId,
    discordUserId: input.discordUserId,
    userId,
    username: input.username,
  });
  return { userCtx: { userId, chatId: chatKey }, chatKey };
}

// ---------------------------------------------------------------------------
// Plain DM messages → agent runtime
// ---------------------------------------------------------------------------

async function handleMessage(db: Db, message: Message): Promise<void> {
  if (message.author.bot) return;

  // Without guild message intents only DMs (and group DMs) arrive here;
  // mirror the Telegram private-chat-only policy anyway.
  if (message.channel.type !== ChannelType.DM) return;

  if (!isDiscordUserAllowed(message.author.id, config.discord.allowedUserId)) {
    log.warn('access denied for discord user');
    await message.reply('Access denied.').catch(() => {});
    return;
  }

  // Forwarded messages carry their text in messageSnapshots, not content.
  const text = (message.content || message.messageSnapshots?.first()?.content || '').trim();
  if (!text) {
    await message.reply('Понимаю только текстовые сообщения.').catch(() => {});
    return;
  }

  if (text.length > MAX_INPUT_LENGTH) {
    await message.reply(`Сообщение слишком длинное (${text.length} символов). Максимум: ${MAX_INPUT_LENGTH}.`);
    return;
  }

  const { userCtx, chatKey } = resolveSessionContext(db, {
    discordUserId: message.author.id,
    username: message.author.username,
    displayName: message.author.displayName,
    channelId: message.channelId,
  });

  const allowance = evaluateChatRequestAllowance({
    chatId: chatKey,
    userId: userCtx.userId,
    hasActiveRequest: hasInFlightRequest(chatKey),
    activeRequestCount: activeRequestCount(),
  });
  if (!allowance.ok) {
    await message.reply(allowance.message ?? 'Запрос отклонён.');
    return;
  }

  const threadId = resolveThreadForChat(db, chatKey, userCtx);

  if (isDuplicateInFlightRequest(chatKey, threadId, text)) {
    await message.reply('Такой же запрос уже обрабатывается.');
    return;
  }

  const requestToken = randomUUID();
  rememberInFlightRequest(chatKey, threadId, text, requestToken);

  const thinkingMsg = await message.reply(pickThinkingPhrase()).catch(() => null);
  const stopTyping = startTyping(message.channel as DMChannel);

  try {
    log.info('message len=%d', text.length);
    const cleaned = await runAgentTurn(db, threadId, userCtx, text);
    await thinkingMsg?.delete().catch(() => {});
    await sendChunks(message.channel as DMChannel, cleaned);
  } catch (err) {
    log.error('agent error: %s', err instanceof Error ? err.message : String(err));
    await thinkingMsg?.delete().catch(() => {});
    await message.reply(normalizeAgentRuntimeError(err)).catch(() => {});
  } finally {
    stopTyping();
    clearInFlightRequest(chatKey, requestToken);
  }
}

// ---------------------------------------------------------------------------
// Slash commands and buttons
// ---------------------------------------------------------------------------

async function handleInteraction(db: Db, interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() && !(interaction.isButton() && interaction.customId.startsWith('switch_char:'))) {
    return;
  }

  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(db, interaction);
    } else if (interaction.isButton()) {
      await handleSwitchButton(db, interaction);
    }
  } catch (err) {
    log.error('interaction error: %s', err instanceof Error ? err.message : String(err));
    // Never leave a deferred interaction hanging — Discord shows an eternal
    // "thinking…" otherwise.
    const message = normalizeAgentRuntimeError(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

async function handleSlashCommand(db: Db, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel || interaction.channel.type !== ChannelType.DM) {
    await interaction.reply({ content: 'Я работаю только в личных сообщениях. Напиши мне в ЛС.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!isDiscordUserAllowed(interaction.user.id, config.discord.allowedUserId)) {
    await interaction.reply({ content: 'Access denied.', flags: MessageFlags.Ephemeral });
    return;
  }

  const { userCtx, chatKey } = resolveSessionContext(db, {
    discordUserId: interaction.user.id,
    username: interaction.user.username,
    displayName: interaction.user.displayName,
    channelId: interaction.channelId,
  });

  switch (interaction.commandName) {
    case 'start':
      await interaction.reply('EVE Agent готов. Пиши любой запрос по EVE Online.\n\n' + COMMANDS_TEXT);
      return;
    case 'help':
      await interaction.reply(COMMANDS_TEXT);
      return;
    case 'eve_login': {
      if (!isEveSsoConfigured()) {
        await interaction.reply(buildEveSsoSetupGuide());
        return;
      }
      // Short link to the app's redirect endpoint — the full SSO URL (~2.1KB)
      // exceeds Discord's 2000-char message and 512-char button limits.
      const url = createEveLoginLink(db, userCtx.userId, chatKey);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Войти через EVE SSO').setURL(url),
      );
      await interaction.reply({
        content: 'Привяжи персонажа EVE по кнопке ниже. После входа используй /characters для переключения.',
        components: [row],
      });
      return;
    }
    case 'whoami': {
      const linked = getLinkedCharacter(db, userCtx);
      if (!linked) {
        await interaction.reply('Персонаж не привязан. Используй /eve_login.');
        return;
      }
      await interaction.reply(
        `Активный персонаж: ${linked.characterName}\nID: ${linked.characterId}\nДоступов (scopes): ${linked.scopes.length}`,
      );
      return;
    }
    case 'characters': {
      const linked = listLinkedCharacters(db, userCtx);
      if (linked.length === 0) {
        await interaction.reply('Персонажи не привязаны. Используй /eve_login.');
        return;
      }
      const lines = linked.map((entry) =>
        `${entry.isActive ? '* ' : '- '}${entry.characterName} (${entry.characterId})`,
      );
      const switchable = linked.filter((entry) => !entry.isActive);
      // Discord hard limits: 5 buttons per row, 5 rows per message.
      const components: Array<ActionRowBuilder<ButtonBuilder>> = [];
      for (let i = 0; i < switchable.length && components.length < 5; i += 5) {
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
          switchable.slice(i, i + 5).map((entry) => new ButtonBuilder()
            .setCustomId(`switch_char:${entry.characterId}`)
            .setLabel(`Переключить: ${entry.characterName}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)),
        ));
      }
      let content = 'Привязанные персонажи:\n' + lines.join('\n');
      if (switchable.length > 25) {
        content += '\n\nКнопок больше 25 — остальные переключай через /use <id>.';
      }
      if (content.length > MAX_DISCORD_LENGTH) {
        content = `${content.slice(0, MAX_DISCORD_LENGTH - 60)}\n… список обрезан, используй /use <id>.`;
      }
      await interaction.reply({ content, components });
      return;
    }
    case 'use': {
      const arg = interaction.options.getString('character', true).trim();
      await interaction.deferReply();
      const list = listLinkedCharacters(db, userCtx);
      if (list.length === 0) {
        await interaction.editReply('Персонажи не привязаны. Используй /eve_login.');
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
          await interaction.editReply(`Несколько совпадений для "${arg}". Используй /use <id>:\n${options}`);
          return;
        }
      }

      if (!match) {
        await interaction.editReply(`Персонаж не найден: ${arg}. Смотри /characters.`);
        return;
      }

      const ok = setActiveCharacter(db, userCtx, match.characterId);
      if (!ok) {
        await interaction.editReply('Не удалось переключить персонажа. Смотри /characters и выбери корректный ID.');
        return;
      }

      insertSwitchNotification(db, chatKey, match.characterId);
      const summaryText = await refreshAndSummarize(db, userCtx, match.characterName, match.characterId);
      await interaction.editReply(summaryText);
      return;
    }
    case 'market': {
      const typeId = interaction.options.getInteger('type_id', true);
      await interaction.deferReply();
      await getEveCapabilities(db, 'discord_market', userCtx);
      const result = await callEsiOperation(db, 'post_ui_openwindow_marketdetails', { type_id: typeId }, userCtx);
      await interaction.editReply(result.ok
        ? `Открыл рынок в клиенте для type_id \`${typeId}\`.`
        : normalizeUiCommandError(result.error));
      return;
    }
    case 'info': {
      const targetId = interaction.options.getInteger('target_id', true);
      await interaction.deferReply();
      await getEveCapabilities(db, 'discord_info', userCtx);
      const result = await callEsiOperation(db, 'post_ui_openwindow_information', { target_id: targetId }, userCtx);
      await interaction.editReply(result.ok
        ? `Открыл окно информации в клиенте для target_id \`${targetId}\`.`
        : normalizeUiCommandError(result.error));
      return;
    }
    case 'version':
    case 'update': {
      await interaction.deferReply();
      const status = await checkForProjectUpdate();
      await interaction.editReply(formatUpdateStatus(status));
      return;
    }
    case 'clear': {
      const cleared = clearChatConversation(db, chatKey);
      log.info('chat_key=%d cleared %d threads', chatKey, cleared);
      await interaction.reply('Диалог очищен.');
      return;
    }
    default:
      await interaction.reply({ content: 'Неизвестная команда.', flags: MessageFlags.Ephemeral });
  }
}

async function handleSwitchButton(db: Db, interaction: ButtonInteraction): Promise<void> {
  if (!interaction.channel || interaction.channel.type !== ChannelType.DM) {
    await interaction.reply({ content: 'Доступно только в личных сообщениях.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!isDiscordUserAllowed(interaction.user.id, config.discord.allowedUserId)) {
    await interaction.reply({ content: 'Access denied.', flags: MessageFlags.Ephemeral });
    return;
  }

  const characterId = Number(interaction.customId.split(':')[1]);
  if (!Number.isFinite(characterId) || characterId <= 0) {
    await interaction.reply({ content: 'Некорректный ID персонажа.', flags: MessageFlags.Ephemeral });
    return;
  }

  const { userCtx, chatKey } = resolveSessionContext(db, {
    discordUserId: interaction.user.id,
    username: interaction.user.username,
    displayName: interaction.user.displayName,
    channelId: interaction.channelId,
  });

  const switchOk = setActiveCharacter(db, userCtx, characterId);
  if (!switchOk) {
    await interaction.reply({ content: 'Не удалось переключить персонажа.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  const list = listLinkedCharacters(db, userCtx);
  const switched = list.find((e) => e.characterId === characterId);
  const charName = switched?.characterName ?? `ID ${characterId}`;

  insertSwitchNotification(db, chatKey, characterId);
  const summaryText = await refreshAndSummarize(db, userCtx, charName, characterId);
  await interaction.editReply(summaryText);
}

// ---------------------------------------------------------------------------
// Sending helpers
// ---------------------------------------------------------------------------

// Headroom for the "Часть N/M\n" prefix so prefixed chunks stay under 2000.
const CHUNK_PREFIX_HEADROOM = 24;

async function sendChunks(channel: DMChannel, text: string): Promise<void> {
  const chunks = splitForDiscord(text, MAX_DISCORD_LENGTH - CHUNK_PREFIX_HEADROOM);
  const total = chunks.length;
  for (let i = 0; i < total; i += 1) {
    const prefix = total > 1 ? `Часть ${i + 1}/${total}\n` : '';
    await channel.send(prefix + chunks[i]);
  }
}

function startTyping(channel: DMChannel): () => void {
  const send = () => channel.sendTyping().catch(() => {});
  send();
  // Discord typing indicator lasts ~10s; refresh every 8s.
  const interval = setInterval(send, 8000);
  return () => clearInterval(interval);
}

/** Outbound sender used by heartbeat / route monitor / kill watch alerts. */
export async function sendDiscordMessage(db: Db, client: Client, chatKey: number, text: string): Promise<void> {
  const channelId = getDiscordChannelId(db, chatKey);
  if (!channelId) {
    throw new Error(`No Discord channel mapped for chat_key=${chatKey}`);
  }
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isSendable()) {
    throw new Error(`Discord channel ${channelId} is not sendable`);
  }
  for (const chunk of splitForDiscord(text)) {
    await channel.send(chunk);
  }
}
