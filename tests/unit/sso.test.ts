import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test-client', clientSecret: 'test-secret', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, handoffTtlSeconds: 300 },
  },
}));

import { getLinkedCharacter, getAccessToken } from '../../src/eve/sso.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('getLinkedCharacter', () => {
  it('returns null when no character is linked', () => {
    expect(getLinkedCharacter(db, { userId: 0, chatId: 1 })).toBeNull();
  });

  it('returns character info when linked to the chat', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'pilot');
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(12345, 'TestPilot', 'tok', 'ref', '["esi-wallet.read_character_wallet.v1"]');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 12345);

    const char = getLinkedCharacter(db, { userId: 0, chatId: 1 });
    expect(char).not.toBeNull();
    expect(char!.characterId).toBe(12345);
    expect(char!.characterName).toBe('TestPilot');
    expect(char!.scopes).toEqual(['esi-wallet.read_character_wallet.v1']);
  });

  it('does not fall back to an unrelated global character', () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(12345, 'TestPilot', 'tok', 'ref', '[]');
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(55, 'other-user');

    expect(getLinkedCharacter(db, { userId: 0, chatId: 55 })).toBeNull();
  });

  it('does not return a character owned by another user', () => {
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))")
      .run(2, 'Other', 12345);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?, ?)
    `).run(12345, 'TestPilot', 'tok', 'ref', '[]', 2);

    expect(getLinkedCharacter(db, { userId: 1 })).toBeNull();
  });
});

describe('getAccessToken', () => {
  it('returns null when no character is linked', async () => {
    const result = await getAccessToken(db, { userId: 0, chatId: 1 });
    expect(result).toBeNull();
  });

  it('returns token when not expired for the linked chat', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'pilot');
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(12345, 'Pilot', 'valid-token', 'ref-token', '[]');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 12345);

    const result = await getAccessToken(db, { userId: 0, chatId: 1 });
    expect(result).not.toBeNull();
    expect(result!.token).toBe('valid-token');
    expect(result!.characterId).toBe(12345);
  });

  it('returns null when token is expired and refresh fails (no network)', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'pilot');
    // Insert with already-expired token
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '-100 seconds'), ?)
    `).run(12345, 'Pilot', 'expired-token', 'ref-token', '[]');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 12345);

    // This will try to refresh via fetch to login.eveonline.com and fail in test env
    const result = await getAccessToken(db, { userId: 0, chatId: 1 });
    expect(result).toBeNull();
  });

  it('returns null when the linked account belongs to another user', async () => {
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))")
      .run(2, 'Other', 12345);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?, ?)
    `).run(12345, 'Pilot', 'valid-token', 'ref-token', '[]', 2);

    const result = await getAccessToken(db, { userId: 1 });
    expect(result).toBeNull();
  });
});
