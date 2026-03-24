import type { Db } from '../db/sqlite.js';
import { resolveWebSessionUser } from './session.js';

export type UserContext = { userId: number; chatId?: number };

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

export function resolveUserFromWebSession(db: Db, sessionId: string): number | null {
  return resolveWebSessionUser(db, sessionId);
}

export function getUserTelegramChatId(db: Db, userId: number): number | null {
  const row = db.prepare(
    'SELECT telegram_user_id FROM telegram_accounts WHERE user_id = ?',
  ).get(userId) as { telegram_user_id: number } | undefined;
  return row?.telegram_user_id ?? null;
}

export function getUserDisplayName(db: Db, userId: number): string | null {
  const row = db.prepare(
    'SELECT display_name FROM users WHERE user_id = ?',
  ).get(userId) as { display_name: string } | undefined;
  return row?.display_name ?? null;
}
