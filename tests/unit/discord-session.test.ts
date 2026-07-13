import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 0 },
    discord: { botToken: 'test', allowedUserId: '' },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 0 },
  },
}));

import {
  ensureDiscordSession,
  getDiscordChannelId,
  getOrCreateDiscordUser,
  getUserDiscordChatKey,
  isDiscordUserAllowed,
} from '../../src/discord/session.js';
import { getUserOutboundChatId } from '../../src/auth/user-resolver.js';
import {
  registerDiscordOutbound,
  registerTelegramOutbound,
  resetOutboundForTests,
} from '../../src/messaging/outbound.js';

// A realistic Discord snowflake: larger than Number.MAX_SAFE_INTEGER as an
// integer, so it must survive round-trips as a string.
const SNOWFLAKE_USER = '1289647321004537857';
const SNOWFLAKE_CHANNEL = '1289647321004537999';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  resetOutboundForTests();
});

describe('discord identity', () => {
  it('creates a user once and preserves the snowflake as text', () => {
    const first = getOrCreateDiscordUser(db, SNOWFLAKE_USER, 'pilot', 'Pilot');
    const second = getOrCreateDiscordUser(db, SNOWFLAKE_USER, 'pilot-renamed');

    expect(second).toBe(first);
    const row = db.prepare('SELECT discord_user_id, username FROM discord_accounts WHERE user_id = ?').get(first) as
      { discord_user_id: string; username: string };
    expect(row.discord_user_id).toBe(SNOWFLAKE_USER);
    expect(row.username).toBe('pilot-renamed');
  });

  it('allocates negative unique chat keys per DM channel', () => {
    const userId = getOrCreateDiscordUser(db, SNOWFLAKE_USER, 'pilot');
    const chatKey = ensureDiscordSession(db, {
      channelId: SNOWFLAKE_CHANNEL,
      discordUserId: SNOWFLAKE_USER,
      userId,
      username: 'pilot',
    });

    expect(chatKey).toBeLessThan(0);

    // Same channel → same key.
    const again = ensureDiscordSession(db, {
      channelId: SNOWFLAKE_CHANNEL,
      discordUserId: SNOWFLAKE_USER,
      userId,
      username: 'pilot',
    });
    expect(again).toBe(chatKey);

    // Different channel → a different negative key.
    const other = ensureDiscordSession(db, {
      channelId: '222222222222222222',
      discordUserId: '333333333333333333',
      userId: getOrCreateDiscordUser(db, '333333333333333333', 'other'),
      username: 'other',
    });
    expect(other).toBeLessThan(0);
    expect(other).not.toBe(chatKey);

    expect(getDiscordChannelId(db, chatKey)).toBe(SNOWFLAKE_CHANNEL);
  });

  it('creates the shared chat session row so chat-keyed tables work', () => {
    const userId = getOrCreateDiscordUser(db, SNOWFLAKE_USER, 'pilot');
    const chatKey = ensureDiscordSession(db, {
      channelId: SNOWFLAKE_CHANNEL,
      discordUserId: SNOWFLAKE_USER,
      userId,
      username: 'pilot',
    });

    const session = db.prepare('SELECT chat_id FROM telegram_sessions WHERE chat_id = ?').get(chatKey);
    expect(session).toBeDefined();

    // FK-referencing insert must succeed.
    db.prepare('INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)').run('t-dc', chatKey, userId);
  });

  it('resolves outbound chat: telegram first, discord fallback', () => {
    const userId = getOrCreateDiscordUser(db, SNOWFLAKE_USER, 'pilot');
    expect(getUserOutboundChatId(db, userId)).toBeNull();

    const chatKey = ensureDiscordSession(db, {
      channelId: SNOWFLAKE_CHANNEL,
      discordUserId: SNOWFLAKE_USER,
      userId,
      username: 'pilot',
    });
    expect(getUserDiscordChatKey(db, userId)).toBe(chatKey);
    expect(getUserOutboundChatId(db, userId)).toBe(chatKey);

    // Linking a Telegram account makes Telegram the preferred channel.
    db.prepare("INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name) VALUES (?, ?, '', '')")
      .run(777, userId);
    expect(getUserOutboundChatId(db, userId)).toBe(777);
  });

  it('never routes notifications to a platform whose sender is offline', () => {
    const userId = getOrCreateDiscordUser(db, SNOWFLAKE_USER, 'pilot');
    const chatKey = ensureDiscordSession(db, {
      channelId: SNOWFLAKE_CHANNEL,
      discordUserId: SNOWFLAKE_USER,
      userId,
      username: 'pilot',
    });
    db.prepare("INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name) VALUES (?, ?, '', '')")
      .run(777, userId);

    // Discord-only deployment: a legacy Telegram link must not swallow alerts.
    registerDiscordOutbound(async () => {});
    expect(getUserOutboundChatId(db, userId)).toBe(chatKey);

    // Telegram back online: prefer it again.
    registerTelegramOutbound(async () => {});
    expect(getUserOutboundChatId(db, userId)).toBe(777);
  });

  it('applies the allowlist only when configured', () => {
    expect(isDiscordUserAllowed(SNOWFLAKE_USER, '')).toBe(true);
    expect(isDiscordUserAllowed(SNOWFLAKE_USER, SNOWFLAKE_USER)).toBe(true);
    expect(isDiscordUserAllowed(SNOWFLAKE_USER, '42')).toBe(false);
  });
});
