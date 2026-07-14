/**
 * Platform-routing outbound message dispatcher.
 *
 * Notification producers (heartbeat, route monitor, kill watch) address chats
 * by internal chat id: zero is the local CLI, positive ids are Telegram
 * private chats, and negative ids are Discord DM chat keys. Each platform
 * registers its sender at boot; a
 * Best-effort producers use sendOutbound(), while durable producers await
 * deliverOutbound() so a failed platform send cannot be mistaken for delivery.
 */
import { createLogger } from '../observability/logger.js';

export type OutboundSender = (chatId: number, text: string) => Promise<void>;

export class OutboundDeliveryError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OutboundDeliveryError';
    this.permanent = permanent;
  }
}

const log = createLogger('outbound');

let telegramSender: OutboundSender | null = null;
let discordSender: OutboundSender | null = null;
let cliSender: OutboundSender | null = null;

export function registerCliOutbound(sender: OutboundSender | null): void {
  cliSender = sender;
}

export function registerTelegramOutbound(sender: OutboundSender | null): void {
  telegramSender = sender;
}

export function registerDiscordOutbound(sender: OutboundSender | null): void {
  discordSender = sender;
}

export function isTelegramOutboundRegistered(): boolean {
  return telegramSender !== null;
}

export function isDiscordOutboundRegistered(): boolean {
  return discordSender !== null;
}

export function isCliOutboundRegistered(): boolean {
  return cliSender !== null;
}

export function isDiscordChatId(chatId: number): boolean {
  return chatId < 0;
}

export function isCliChatId(chatId: number): boolean {
  return chatId === 0;
}

/** Whether the chat's platform has an active sender in this process. */
export function isOutboundAvailable(chatId: number): boolean {
  if (isCliChatId(chatId)) return isCliOutboundRegistered();
  return isDiscordChatId(chatId)
    ? isDiscordOutboundRegistered()
    : isTelegramOutboundRegistered();
}

/**
 * Awaitable delivery boundary for durable notification producers.
 *
 * Missing platform registration and platform errors reject. Callers that own a
 * durable cursor/deduplication transaction must advance it only after this
 * promise resolves.
 */
export async function deliverOutbound(chatId: number, text: string): Promise<void> {
  const platform = isCliChatId(chatId) ? 'cli' : isDiscordChatId(chatId) ? 'discord' : 'telegram';
  const sender = isCliChatId(chatId) ? cliSender : isDiscordChatId(chatId) ? discordSender : telegramSender;
  if (!sender) {
    throw new Error(`${platform} outbound sender is not registered`);
  }
  try {
    await sender(chatId, text);
  } catch (error) {
    throw new OutboundDeliveryError(
      error instanceof Error ? error.message : String(error),
      isTerminalPlatformError(error),
      { cause: error },
    );
  }
}

/** True only when the platform has definitively rejected this recipient. */
export function isPermanentOutboundFailure(error: unknown): boolean {
  return error instanceof OutboundDeliveryError && error.permanent;
}

function isTerminalPlatformError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const response = asRecord(record.response);
  const rawCode = record.code ?? record.error_code ?? response?.error_code;
  const code = typeof rawCode === 'number' || typeof rawCode === 'string'
    ? Number(rawCode)
    : Number.NaN;
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  // Telegram 403 means the bot was blocked or removed from the target chat.
  if (code === 403) return true;
  if (code === 400 && (
    message.includes('chat not found')
    || message.includes('user is deactivated')
    || message.includes('bot was kicked')
    || message.includes('bot is not a member')
  )) return true;

  // Discord REST errors that permanently identify an unavailable recipient.
  return message.startsWith('no discord channel mapped for chat_key=')
    || /^discord channel \d+ is not sendable$/.test(message)
    || code === 10_003 // Unknown Channel
    || code === 10_013 // Unknown User
    || code === 50_001 // Missing Access
    || code === 50_007 // Cannot send messages to this user
    || code === 50_013; // Missing Permissions
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

/**
 * Fire-and-forget send with platform routing. Errors are logged, never thrown:
 * producers must not die because one chat is unreachable.
 */
export function sendOutbound(chatId: number, text: string): void {
  const platform = isDiscordChatId(chatId) ? 'discord' : 'telegram';
  void deliverOutbound(chatId, text)
    .catch((err) => {
      log.error('%s send failed for chat=%d: %s', platform, chatId, err instanceof Error ? err.message : String(err));
    });
}

export function resetOutboundForTests(): void {
  cliSender = null;
  telegramSender = null;
  discordSender = null;
}
