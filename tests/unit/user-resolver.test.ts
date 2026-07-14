import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { resolveUserContextForChat } from '../../src/auth/user-resolver.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'CLI'), (2, 'TG'), (3, 'Discord')").run();
  db.prepare("INSERT INTO cli_accounts (identity_key, user_id, chat_id) VALUES ('local', 1, 0)").run();
  db.prepare("INSERT INTO telegram_accounts (telegram_user_id, user_id) VALUES (22, 2)").run();
  db.prepare("INSERT INTO discord_sessions (discord_channel_id, discord_user_id, user_id, chat_key) VALUES ('333', '33', 3, -1)").run();
});

afterEach(() => db.close());

describe('resolveUserContextForChat', () => {
  it('resolves all three collision-free chat lanes', () => {
    expect(resolveUserContextForChat(db, 0)).toEqual({ userId: 1, chatId: 0, notificationCapability: 'feed' });
    expect(resolveUserContextForChat(db, 22)).toEqual({ userId: 2, chatId: 22 });
    expect(resolveUserContextForChat(db, -1)).toEqual({ userId: 3, chatId: -1 });
    expect(resolveUserContextForChat(db, 999)).toBeNull();
  });
});
