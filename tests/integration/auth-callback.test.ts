import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('EVE auth callback flow (DB layer)', () => {
  it('stores character data after successful auth', () => {
    // Simulate what the callback handler does after token exchange
    const characterId = 95465499;
    const characterName = 'CCP Bartender';
    const accessToken = 'fake-access-token';
    const refreshToken = 'fake-refresh-token';
    const scopes = ['esi-wallet.read_character_wallet.v1', 'esi-assets.read_assets.v1'];

    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
      ON CONFLICT(character_id) DO UPDATE SET
        character_name = excluded.character_name,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scopes_json = excluded.scopes_json
    `).run(characterId, characterName, accessToken, refreshToken, JSON.stringify(scopes));

    const row = db.prepare('SELECT * FROM eve_accounts WHERE character_id = ?').get(characterId) as {
      character_id: number;
      character_name: string;
      scopes_json: string;
    };

    expect(row.character_id).toBe(95465499);
    expect(row.character_name).toBe('CCP Bartender');
    expect(JSON.parse(row.scopes_json)).toEqual(scopes);
  });

  it('updates existing character on re-auth', () => {
    // First auth
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(100, 'OldName', 'old-tok', 'old-ref', '["scope1"]');

    // Re-auth with new scopes
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
      ON CONFLICT(character_id) DO UPDATE SET
        character_name = excluded.character_name,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scopes_json = excluded.scopes_json
    `).run(100, 'NewName', 'new-tok', 'new-ref', '["scope1","scope2"]');

    const row = db.prepare('SELECT * FROM eve_accounts WHERE character_id = ?').get(100) as {
      character_name: string;
      access_token: string;
      scopes_json: string;
    };

    expect(row.character_name).toBe('NewName');
    expect(row.access_token).toBe('new-tok');
    expect(JSON.parse(row.scopes_json)).toHaveLength(2);
  });
});
