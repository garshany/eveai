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
    web: { baseUrl: 'https://eve.example.com', sessionTtlHours: 720, handoffTtlSeconds: 300 },
  },
}));

import {
  buildLogoutCookie,
  buildSessionCookie,
  createWebSession,
  deleteWebSession,
  resolveWebSessionUser,
} from '../../src/auth/session.js';
import { createHandoffToken, consumeHandoffToken } from '../../src/auth/handoff.js';

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

describe('auth secret storage', () => {
  it('stores web sessions as protected digests while preserving lookup and delete', () => {
    const sessionId = createWebSession(db, 1);
    const row = db.prepare('SELECT session_id FROM web_sessions WHERE user_id = ?').get(1) as { session_id: string };

    expect(row.session_id).not.toBe(sessionId);
    expect(row.session_id.startsWith('h1:')).toBe(true);
    expect(resolveWebSessionUser(db, sessionId)).toBe(1);

    deleteWebSession(db, sessionId);
    expect(resolveWebSessionUser(db, sessionId)).toBeNull();
  });

  it('marks session cookies Secure on HTTPS web origins', () => {
    const sessionCookie = buildSessionCookie('session-id', 24);
    const logoutCookie = buildLogoutCookie();

    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('HttpOnly');
    expect(logoutCookie).toContain('Secure');
    expect(logoutCookie).toContain('Max-Age=0');
  });

  it('stores handoff tokens as protected digests while preserving one-time consumption', () => {
    const token = createHandoffToken(db, 1, 99);
    const row = db.prepare("SELECT state FROM auth_requests WHERE type = 'tg_handoff'").get() as { state: string };

    expect(row.state).not.toBe(token);
    expect(row.state.startsWith('h1:')).toBe(true);
    expect(consumeHandoffToken(db, token)).toBe(1);
    expect(consumeHandoffToken(db, token)).toBeNull();
  });

  it('still resolves legacy plaintext session and handoff rows', () => {
    db.prepare(`
      INSERT INTO web_sessions (session_id, user_id, expires_at, created_at)
      VALUES (?, ?, datetime('now', '+1 hour'), datetime('now'))
    `).run('legacy-session', 1);
    db.prepare(`
      INSERT INTO auth_requests (state, type, user_id, chat_id, created_at, expires_at)
      VALUES (?, 'tg_handoff', ?, ?, datetime('now'), datetime('now', '+300 seconds'))
    `).run('legacy-handoff', 1, 99);

    expect(resolveWebSessionUser(db, 'legacy-session')).toBe(1);
    expect(consumeHandoffToken(db, 'legacy-handoff')).toBe(1);
  });
});
