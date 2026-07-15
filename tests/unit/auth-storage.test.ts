import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test-openai-key', model: 'test' },
    eve: { clientId: 'test-client', clientSecret: 'test-secret', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'https://eve.example.com' },
  },
}));

import {
  createAuthRequestToken,
  findPendingAuthRequest,
  markAuthRequestUsed,
} from '../../src/auth/auth-request.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
    .run(1, 'pilot');
});

afterEach(() => {
  db.close();
});

describe('auth request storage', () => {
  it('stores SSO states as protected digests while preserving lookup', () => {
    const token = createAuthRequestToken(db, 'eve_sso', 1, { chatId: 99, ttlSeconds: 600 });
    const row = db.prepare("SELECT state FROM auth_requests WHERE type = 'eve_sso'").get() as { state: string };

    expect(row.state).not.toBe(token);
    expect(row.state.startsWith('h1:')).toBe(true);

    const pending = findPendingAuthRequest(db, 'eve_sso', token);
    expect(pending).toEqual({ user_id: 1, chat_id: 99, type: 'eve_sso', redirect_url: null });
  });

  it('consumes SSO states only once', () => {
    const token = createAuthRequestToken(db, 'eve_sso', 1, { ttlSeconds: 600 });

    expect(findPendingAuthRequest(db, 'eve_sso', token)).not.toBeNull();
    markAuthRequestUsed(db, 'eve_sso', token);
    expect(findPendingAuthRequest(db, 'eve_sso', token)).toBeNull();
  });

  it('rejects expired SSO states', () => {
    const token = createAuthRequestToken(db, 'eve_sso', 1, { ttlSeconds: 600 });
    db.prepare("UPDATE auth_requests SET expires_at = datetime('now', '-1 second')").run();

    expect(findPendingAuthRequest(db, 'eve_sso', token)).toBeNull();
  });

  it('still resolves legacy plaintext state rows', () => {
    db.prepare(`
      INSERT INTO auth_requests (state, type, user_id, chat_id, created_at, expires_at)
      VALUES (?, 'eve_sso', ?, ?, datetime('now'), datetime('now', '+600 seconds'))
    `).run('legacy-state', 1, 99);

    expect(findPendingAuthRequest(db, 'eve_sso', 'legacy-state')).toEqual({
      user_id: 1,
      chat_id: 99,
      type: 'eve_sso',
      redirect_url: null,
    });
  });
});
