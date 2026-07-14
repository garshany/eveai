import type { Db } from '../db/sqlite.js';
import { isDiscordOutboundRegistered, isTelegramOutboundRegistered } from '../messaging/outbound.js';

export type UserContext = {
  userId: number;
  chatId?: number;
  /** False for transient lanes that cannot receive durable background alerts. */
  durableNotifications?: boolean;
};

export function getOrCreateUser(
  db: Db,
  telegramUserId: number,
  username?: string,
  firstName?: string,
): number {
  const existing = db.prepare(
    'SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?',
  ).get(telegramUserId) as { user_id: number } | undefined;

  if (existing) {
    if (username !== undefined) {
      db.prepare(
        'UPDATE telegram_accounts SET username = ? WHERE telegram_user_id = ?',
      ).run(username, telegramUserId);
    }
    return existing.user_id;
  }

  const displayName = firstName || username || `tg:${telegramUserId}`;
  const result = db.prepare(
    "INSERT INTO users (display_name, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))",
  ).run(displayName);
  const userId = Number(result.lastInsertRowid);

  db.prepare(
    "INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
  ).run(telegramUserId, userId, username ?? '', firstName ?? '');

  return userId;
}

export function getUserTelegramChatId(db: Db, userId: number): number | null {
  const row = db.prepare(
    'SELECT telegram_user_id FROM telegram_accounts WHERE user_id = ?',
  ).get(userId) as { telegram_user_id: number } | undefined;
  return row?.telegram_user_id ?? null;
}

/**
 * Preferred outbound chat for user-keyed notifications: Telegram private chat
 * when linked AND the Telegram bot is running, otherwise the most recent
 * Discord DM lane (negative chat key) when the Discord bot is running. Never
 * returns a chat whose platform sender is offline — the message would be
 * silently dropped by the dispatcher.
 */
export function getUserOutboundChatId(db: Db, userId: number): number | null {
  const telegramChatId = getUserTelegramChatId(db, userId);
  if (telegramChatId && isTelegramOutboundRegistered()) return telegramChatId;

  const row = db.prepare(
    'SELECT chat_key FROM discord_sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1',
  ).get(userId) as { chat_key: number } | undefined;
  if (row?.chat_key && isDiscordOutboundRegistered()) return row.chat_key;

  // No live platform sender (e.g. unit tests) — fall back to whichever chat
  // exists so callers can still resolve an address.
  if (!isTelegramOutboundRegistered() && !isDiscordOutboundRegistered()) {
    return telegramChatId ?? row?.chat_key ?? null;
  }
  return null;
}

export function getUserDisplayName(db: Db, userId: number): string | null {
  const row = db.prepare(
    'SELECT display_name FROM users WHERE user_id = ?',
  ).get(userId) as { display_name: string } | undefined;
  return row?.display_name ?? null;
}
