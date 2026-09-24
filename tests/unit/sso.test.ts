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
      userAgent: 'EVEAI/3.3 (+https://github.com/example/eveai; contact=operator@example.com)',
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

import { getLinkedCharacter, getAccessToken, unlinkCharacter, resetRefreshBackoffForTests } from '../../src/eve/sso.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetEveSsoMetadataCacheForTests } from '../../src/eve/sso-auth.js';
import { withUserProfileAuthorizationLock } from '../../src/eve/user-profile-storage.js';

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
  resetRefreshBackoffForTests();
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

describe('getAccessToken refresh failures', () => {
  function seedExpired(): void {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'pilot');
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '-100 seconds'), ?)
    `).run(12345, 'Pilot', 'expired-token', 'ref-token', '[]');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 12345);
  }
  const metadataResponse = {
    ok: true,
    json: async () => ({
      authorization_endpoint: 'https://login.eveonline.com/v2/oauth/authorize',
      token_endpoint: 'https://login.eveonline.com/v2/oauth/token',
      jwks_uri: 'https://login.eveonline.com/oauth/jwks',
    }),
  };

  it('returns null when the token endpoint answers with a non-JSON body', async () => {
    seedExpired();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(metadataResponse)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });

    await expect(getAccessToken(db, { userId: 0, chatId: 1 })).resolves.toBeNull();
    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('ref-token');
    errorSpy.mockRestore();
  });

  it('returns null when the refreshed JWT fails verification', async () => {
    seedExpired();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(metadataResponse)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'bad-jwt', refresh_token: 'new-ref', expires_in: 1200 }),
      });
    jwtVerifyMock.mockRejectedValue(new Error('signature verification failed'));

    await expect(getAccessToken(db, { userId: 0, chatId: 1 })).resolves.toBeNull();
    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('bad-jwt');
    expect(logged).not.toContain('new-ref');
    errorSpy.mockRestore();
  });
});

describe('getAccessToken dead refresh token backoff', () => {
  const tokenEndpoint = 'https://login.eveonline.com/v2/oauth/token';
  let tokenStatus: number;
  let tokenCalls: number;
  let sentRefreshTokens: string[];

  function seedExpired(refreshToken = 'ref-token'): void {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'pilot');
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '-100 seconds'), ?)
    `).run(12345, 'Pilot', 'expired-token', refreshToken, '[]');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 12345);
  }

  beforeEach(() => {
    tokenStatus = 400;
    tokenCalls = 0;
    sentRefreshTokens = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== tokenEndpoint) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authorization_endpoint: 'https://login.eveonline.com/v2/oauth/authorize',
            token_endpoint: tokenEndpoint,
            jwks_uri: 'https://login.eveonline.com/oauth/jwks',
          }),
        };
      }
      tokenCalls += 1;
      sentRefreshTokens.push(new URLSearchParams(String(init?.body)).get('refresh_token') ?? '');
      if (tokenStatus !== 200) {
        return {
          ok: false,
          status: tokenStatus,
          headers: new Headers(),
          json: async () => ({ error: 'invalid_grant' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token', expires_in: 1200 }),
      };
    });
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'CHARACTER:EVE:12345', name: 'Pilot', aud: ['test-client', 'EVE Online'] },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops calling SSO after invalid_grant, escalates the backoff, and never logs the token', async () => {
    seedExpired();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = { userId: 0, chatId: 1 };

    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    expect(tokenCalls).toBe(1);
    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    expect(tokenCalls).toBe(1);

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    expect(tokenCalls).toBe(2);

    // Second rejection doubles the pause to 10 minutes.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    expect(tokenCalls).toBe(2);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    tokenStatus = 401;
    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    expect(tokenCalls).toBe(3);

    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('ref-token');
    errorSpy.mockRestore();
  });

  it('clears the backoff when a re-login stores a new refresh token', async () => {
    seedExpired();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = { userId: 0, chatId: 1 };

    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    expect(tokenCalls).toBe(1);

    db.prepare('UPDATE eve_accounts SET refresh_token = ? WHERE character_id = ?').run('relogin-ref-token', 12345);
    tokenStatus = 200;
    await expect(getAccessToken(db, ctx)).resolves.toEqual({ token: 'fresh-access-token', characterId: 12345 });
    expect(tokenCalls).toBe(2);
    expect(sentRefreshTokens.at(-1)).toBe('relogin-ref-token');
    vi.mocked(console.error).mockRestore();
  });

  it('does not back off on transient SSO failures', async () => {
    seedExpired();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = { userId: 0, chatId: 1 };
    tokenStatus = 502;

    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    const afterFirst = tokenCalls;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    await expect(getAccessToken(db, ctx)).resolves.toBeNull();
    expect(tokenCalls).toBeGreaterThan(afterFirst);
    vi.mocked(console.error).mockRestore();
  });
});

describe('character-pinned UserContext', () => {
  function seedUserWithTwoCharacters(): void {
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))")
      .run(7, 'Owner', 222);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(70, 'owner');
    const insertAccount = db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), '[]', ?)
    `);
    insertAccount.run(111, 'Alpha', 'token-a', 'ref-a', 7);
    insertAccount.run(222, 'Bravo', 'token-b', 'ref-b', 7);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)').run(70, 111, 7);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)').run(70, 222, 7);
  }

  it('resolves the pinned character instead of the currently active one', async () => {
    seedUserWithTwoCharacters();

    expect(getLinkedCharacter(db, { userId: 7 })?.characterId).toBe(222);
    expect(getLinkedCharacter(db, { userId: 7, characterId: 111 })?.characterId).toBe(111);
    await expect(getAccessToken(db, { userId: 7, characterId: 111 }))
      .resolves.toEqual({ token: 'token-a', characterId: 111 });
    // Pinning never rewrites the user's active character.
    const active = db.prepare('SELECT active_character_id FROM users WHERE user_id = 7').get() as { active_character_id: number };
    expect(active.active_character_id).toBe(222);
  });

  it('returns null for a pinned character the user does not own', async () => {
    seedUserWithTwoCharacters();
    db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
      .run(8, 'Stranger');
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), '[]', ?)
    `).run(333, 'Charlie', 'token-c', 'ref-c', 8);

    expect(getLinkedCharacter(db, { userId: 7, characterId: 333 })).toBeNull();
    await expect(getAccessToken(db, { userId: 7, characterId: 333 })).resolves.toBeNull();
    expect(getLinkedCharacter(db, { userId: 7, characterId: 999 })).toBeNull();
  });
});

describe('unlinkCharacter', () => {
  it('removes tokens and profile artifact when the last character link is deleted', async () => {
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))")
      .run(7, 'Pilot', 12345);
    db.prepare("INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(77, 7, 'pilot', 'Pilot');
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(77, 'pilot', 12345);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(78, 'pilot-alt', 12345);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?, ?)
    `).run(12345, 'Pilot', 'valid-token', 'ref-token', '[]', 7);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)').run(77, 12345, 7);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)').run(78, 12345, 7);

    const profilePath = join(profileDir, 'USER_77_12345.md');
    const alternateProfilePath = join(profileDir, 'USER_78_12345.md');
    const userOnlyProfilePath = join(profileDir, 'USER_7_12345.md');
    writeFileSync(profilePath, 'profile');
    writeFileSync(alternateProfilePath, 'alternate profile');
    writeFileSync(userOnlyProfilePath, 'user profile');
    db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(12345, 7);

    let releaseWriter = (): void => {};
    let markWriterEntered = (): void => {};
    const writerEntered = new Promise<void>((resolve) => {
      markWriterEntered = resolve;
    });
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const oldWriter = withUserProfileAuthorizationLock(12345, async () => {
      markWriterEntered();
      await writerRelease;
      writeFileSync(profilePath, 'late old profile');
    });
    await writerEntered;
    const unlink = unlinkCharacter(db, { userId: 7, chatId: 77 }, 12345);
    releaseWriter();
    await oldWriter;

    expect(await unlink).toBe(true);
    expect(db.prepare('SELECT * FROM eve_accounts WHERE character_id = ?').get(12345)).toBeUndefined();
    expect(existsSync(profilePath)).toBe(false);
    expect(existsSync(alternateProfilePath)).toBe(false);
    expect(existsSync(userOnlyProfilePath)).toBe(false);
  });
});
