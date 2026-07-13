/**
 * Platform-routing outbound message dispatcher.
 *
 * Notification producers (heartbeat, route monitor, kill watch) address chats
 * by internal chat id: positive ids are Telegram private chats, negative ids
 * are Discord DM chat keys. Each platform registers its sender at boot; a
 * message for a platform with no registered sender is logged and dropped so
 * one disabled platform never crashes the producers.
 */
import { createLogger } from '../observability/logger.js';

export type OutboundSender = (chatId: number, text: string) => Promise<void>;

const log = createLogger('outbound');

let telegramSender: OutboundSender | null = null;
let discordSender: OutboundSender | null = null;

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

export function isDiscordChatId(chatId: number): boolean {
  return chatId < 0;
}

/**
 * Fire-and-forget send with platform routing. Errors are logged, never thrown:
 * producers must not die because one chat is unreachable.
 */
export function sendOutbound(chatId: number, text: string): void {
  const platform = isDiscordChatId(chatId) ? 'discord' : 'telegram';
  const sender = isDiscordChatId(chatId) ? discordSender : telegramSender;
  if (!sender) {
    log.warn('dropping message for chat=%d: %s bot is not running', chatId, platform);
    return;
  }
  void Promise.resolve()
    .then(() => sender(chatId, text))
    .catch((err) => {
      log.error('%s send failed for chat=%d: %s', platform, chatId, err instanceof Error ? err.message : String(err));
    });
}

export function resetOutboundForTests(): void {
  telegramSender = null;
  discordSender = null;
}
