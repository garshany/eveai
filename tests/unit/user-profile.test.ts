import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const profileDir = '/tmp/eve-agent-user-profile-tests';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 0 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, handoffTtlSeconds: 300 },
    userProfile: { path: '/tmp/eve-agent-user-profile-tests/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
  },
}));

import { readUserProfile } from '../../src/eve/user-profile.js';

let db: Database.Database;

beforeEach(() => {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(10, 'u1', 7001);
  db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(11, 'u2', 7001);
  db.prepare(`
    INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
    VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
  `).run(7001, 'Pilot', 'tok', 'ref', '[]');
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(10, 7001);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(11, 7001);
});

afterEach(() => {
  db.close();
  rmSync(profileDir, { recursive: true, force: true });
});

describe('readUserProfile', () => {
  it('reads only the profile file for the current chat and character pair', () => {
    writeFileSync(join(profileDir, 'USER_10_7001.md'), 'profile for chat 10');

    expect(readUserProfile(db, { userId: 0, chatId: 10 })).toBe('profile for chat 10');
    expect(readUserProfile(db, { userId: 0, chatId: 11 })).toBeNull();
  });
});
