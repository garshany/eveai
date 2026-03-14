import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test-client', clientSecret: 'test-secret', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '0.0.0.0' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
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
    expect(getLinkedCharacter(db)).toBeNull();
  });

  it('returns character info when linked', () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(12345, 'TestPilot', 'tok', 'ref', '["esi-wallet.read_character_wallet.v1"]');

    const char = getLinkedCharacter(db);
    expect(char).not.toBeNull();
    expect(char!.characterId).toBe(12345);
    expect(char!.characterName).toBe('TestPilot');
    expect(char!.scopes).toEqual(['esi-wallet.read_character_wallet.v1']);
  });
});

describe('getAccessToken', () => {
  it('returns null when no character is linked', async () => {
    const result = await getAccessToken(db);
    expect(result).toBeNull();
  });

  it('returns token when not expired', async () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(12345, 'Pilot', 'valid-token', 'ref-token', '[]');

    const result = await getAccessToken(db);
    expect(result).not.toBeNull();
    expect(result!.token).toBe('valid-token');
    expect(result!.characterId).toBe(12345);
  });

  it('returns null when token is expired and refresh fails (no network)', async () => {
    // Insert with already-expired token
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '-100 seconds'), ?)
    `).run(12345, 'Pilot', 'expired-token', 'ref-token', '[]');

    // This will try to refresh via fetch to login.eveonline.com and fail in test env
    const result = await getAccessToken(db);
    expect(result).toBeNull();
  });
});
