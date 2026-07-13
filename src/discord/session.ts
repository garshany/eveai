/**
 * Discord identity and session mapping.
 *
 * Discord snowflake ids are 64-bit and exceed Number.MAX_SAFE_INTEGER, so they
 * are stored as TEXT. Every DM channel gets an internal negative integer
 * `chat_key` that is used as chat_id in all shared chat-keyed tables
 * (agent_threads, eve_character_links, kill_watches, route_monitors).
 * Telegram private chat ids are positive, so the keyspaces never collide.
 */
import type { Db } from '../db/sqlite.js';
import { ensureChatSessionRow } from '../chat/shared.js';

export function getOrCreateDiscordUser(
  db: Db,
  discordUserId: string,
  username?: string,
  displayName?: string,
): number {
  const existing = db.prepare(
    'SELECT user_id FROM discord_accounts WHERE discord_user_id = ?',
  ).get(discordUserId) as { user_id: number } | undefined;

  if (existing) {
    if (username !== undefined) {
      db.prepare(
        'UPDATE discord_accounts SET username = ? WHERE discord_user_id = ?',
      ).run(username, discordUserId);
    }
    return existing.user_id;
  }

  const name = displayName || username || `discord:${discordUserId}`;
  const create = db.transaction((): number => {
    const result = db.prepare(
      "INSERT INTO users (display_name, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))",
    ).run(name);
    const userId = Number(result.lastInsertRowid);

    db.prepare(
      "INSERT INTO discord_accounts (discord_user_id, user_id, username, created_at) VALUES (?, ?, ?, datetime('now'))",
    ).run(discordUserId, userId, username ?? '');

    return userId;
  });
  return create();
}

/**
 * Resolve (or allocate) the internal negative chat key for a Discord DM
 * channel and refresh session metadata.
 */
export function ensureDiscordSession(
  db: Db,
  input: { channelId: string; discordUserId: string; userId: number; username?: string },
): number {
  // IMMEDIATE so the MIN(chat_key)-1 read and the INSERT take the write lock as
  // one unit — two concurrent DM opens can't compute the same key.
  const allocate = db.transaction((): number => {
    const existing = db.prepare(
      'SELECT chat_key FROM discord_sessions WHERE discord_channel_id = ?',
    ).get(input.channelId) as { chat_key: number } | undefined;

    if (existing) {
      db.prepare(
        "UPDATE discord_sessions SET username = ?, user_id = ?, last_seen_at = datetime('now') WHERE discord_channel_id = ?",
      ).run(input.username ?? '', input.userId, input.channelId);
      return existing.chat_key;
    }

    const next = db.prepare(
      'SELECT COALESCE(MIN(chat_key), 0) - 1 AS next_key FROM discord_sessions',
    ).get() as { next_key: number };

    db.prepare(`
      INSERT INTO discord_sessions (discord_channel_id, discord_user_id, user_id, chat_key, username, last_seen_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(input.channelId, input.discordUserId, input.userId, next.next_key, input.username ?? '');

    return next.next_key;
  });

  const chatKey = allocate.immediate();
  // Shared chat-session row keyed by the internal chat key: keeps
  // FK-referencing tables and active-character resolution working unchanged.
  ensureChatSessionRow(db, chatKey, input.username ?? '');
  return chatKey;
}

/** Look up the DM channel snowflake for an internal Discord chat key. */
export function getDiscordChannelId(db: Db, chatKey: number): string | null {
  const row = db.prepare(
    'SELECT discord_channel_id FROM discord_sessions WHERE chat_key = ?',
  ).get(chatKey) as { discord_channel_id: string } | undefined;
  return row?.discord_channel_id ?? null;
}

/** Find a user's most recent Discord chat key (for user-keyed notifications). */
export function getUserDiscordChatKey(db: Db, userId: number): number | null {
  const row = db.prepare(
    'SELECT chat_key FROM discord_sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1',
  ).get(userId) as { chat_key: number } | undefined;
  return row?.chat_key ?? null;
}

export function isDiscordUserAllowed(discordUserId: string, allowedUserId: string): boolean {
  if (!allowedUserId.trim()) return true;
  return discordUserId === allowedUserId.trim();
}
