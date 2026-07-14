import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const { jwtVerifyMock, createRemoteJwkSetMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  createRemoteJwkSetMock: vi.fn(() => ({})),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback',
      requestTimeoutMs: 5000,
    },
    esi: {
      userAgent: 'EVEAI/3.1 (+https://github.com/example/eveai; contact=operator@example.com)',
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, handoffTtlSeconds: 300 },
    userProfile: { path: '/tmp/eve-agent-sso-tests/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
  },
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: createRemoteJwkSetMock,
  jwtVerify: jwtVerifyMock,
}));

import { getLinkedCharacter, getAccessToken, unlinkCharacter } from '../../src/eve/sso.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetEveSsoMetadataCacheForTests } from '../../src/eve/sso-auth.js';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;
const profileDir = '/tmp/eve-agent-sso-tests';

beforeEach(() => {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  jwtVerifyMock.mockReset();
  createRemoteJwkSetMock.mockClear();
  resetEveSsoMetadataCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  rmSync(profileDir, { recursive: true, force: true });
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

    fetchMock.mockRejectedValue(new Error('network down'));

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

  it('returns null instead of throwing when stored tokens cannot be decrypted', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'pilot');
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(12345, 'Pilot', 'enc:v1:broken', 'enc:v1:broken', '[]');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 12345);

    await expect(getAccessToken(db, { userId: 0, chatId: 1 })).resolves.toBeNull();
  });

  it('refreshes expired tokens via discovered SSO metadata and validates the new JWT', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'pilot');
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '-100 seconds'), ?)
    `).run(12345, 'Pilot', 'expired-token', 'ref-token', '[]');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 12345);

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://login.eveonline.com/v2/oauth/authorize',
          token_endpoint: 'https://login.eveonline.com/v2/oauth/token',
          jwks_uri: 'https://login.eveonline.com/oauth/jwks',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 1200,
        }),
      });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'CHARACTER:EVE:12345',
        name: 'Pilot',
        aud: ['test-client', 'EVE Online'],
      },
    });

    const result = await getAccessToken(db, { userId: 0, chatId: 1 });

    expect(result).toEqual({ token: 'fresh-access-token', characterId: 12345 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://login.eveonline.com/.well-known/oauth-authorization-server',
      expect.objectContaining({
        headers: expect.anything(),
        signal: expect.anything(),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://login.eveonline.com/v2/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.anything(),
        signal: expect.anything(),
      }),
    );
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'fresh-access-token',
      expect.anything(),
      expect.objectContaining({
        issuer: expect.arrayContaining(['https://login.eveonline.com/']),
      }),
    );
  });
});

describe('unlinkCharacter', () => {
  it('removes tokens and profile artifact when the last character link is deleted', async () => {
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))")
      .run(7, 'Pilot', 12345);
    db.prepare("INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(77, 7, 'pilot', 'Pilot');
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(77, 'pilot', 12345);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?, ?)
    `).run(12345, 'Pilot', 'valid-token', 'ref-token', '[]', 7);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)').run(77, 12345, 7);

    const profilePath = join(profileDir, 'USER_77_12345.md');
    writeFileSync(profilePath, 'profile');
    db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(12345, 7);

    expect(await unlinkCharacter(db, { userId: 7, chatId: 77 }, 12345)).toBe(true);
    expect(db.prepare('SELECT * FROM eve_accounts WHERE character_id = ?').get(12345)).toBeUndefined();
    expect(existsSync(profilePath)).toBe(false);
  });
});
