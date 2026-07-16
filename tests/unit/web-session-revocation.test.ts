import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const PROFILE_DIR = '/tmp/eve-agent-web-session-revocation-tests';

vi.mock('../../src/config.js', () => ({
  config: {
    web: {
      baseUrl: 'http://localhost:3000',
      sessionTtlHours: 720,
      sessionCreationWindowSeconds: 600,
      maxSessionCreationsPerWindow: 30,
    },
    userProfile: {
      path: '/tmp/eve-agent-web-session-revocation-tests/USER_{chat_id}_{character_id}.md',
      refreshSeconds: 300,
    },
  },
}));

import { protectOpaqueToken } from '../../src/auth/secret-storage.js';
import {
  resolveUserProfilePath,
  withUserProfileAuthorizationLock,
} from '../../src/eve/user-profile-storage.js';
import { cleanExpiredWebSessions, revokeWebSession } from '../../src/web/web-session.js';
import { getLinkedCharacter } from '../../src/eve/sso.js';
import { withWebLaneAuthorizationLock } from '../../src/web/web-lane-lock.js';

let db: Database.Database;

beforeEach(() => {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
});

describe('browser session revocation', () => {
  it('purges an expired browser monitor before startup restoration can resume it', async () => {
    const userId = 10;
    const chatId = -2_000_000_010;
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (?, 'Expired capsuleer')").run(userId);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, 'web')").run(chatId);
    db.prepare(`
      INSERT INTO web_sessions (session_hash, csrf_hash, user_id, chat_id, expires_at)
      VALUES ('h1:expired-session', 'h1:expired-csrf', ?, ?, datetime('now', '-1 second'))
    `).run(userId, chatId);
    db.prepare(`
      INSERT INTO route_monitors (chat_id, character_id, origin_id, destination_id, route_systems)
      VALUES (?, 7002, 30000142, 30002187, '[30000142,30002187]')
    `).run(chatId);

    await cleanExpiredWebSessions(db);

    expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = ?').get(chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId)).toBeUndefined();
  });

  it('waits for an in-flight profile writer and then removes every browser-only artifact', async () => {
    const token = 'browser-session-token';
    const userId = 1;
    const chatId = -2_000_000_000;
    const characterId = 7001;
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, 'Web capsuleer', ?)")
      .run(userId, characterId);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, 'web', ?)")
      .run(chatId, characterId);
    db.prepare(`
      INSERT INTO web_sessions (
        session_hash, csrf_hash, user_id, chat_id, created_at, last_seen_at, expires_at
      ) VALUES (?, 'h1:csrf', ?, ?, datetime('now'), datetime('now'), datetime('now', '+1 hour'))
    `).run(protectOpaqueToken(token, 'web_session'), userId, chatId);
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (?, 'Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), ?, ?)
    `).run(characterId, JSON.stringify(['esi-wallet.read_character_wallet.v1']), userId);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(chatId, characterId, userId);

    const lanePath = resolveUserProfilePath({ userId, chatId }, characterId);
    const userPath = resolveUserProfilePath({ userId }, characterId);
    writeFileSync(lanePath, 'old private lane profile');
    writeFileSync(userPath, 'old private user profile');

    let releaseWriter = (): void => {};
    let markWriterEntered = (): void => {};
    const writerEntered = new Promise<void>((resolve) => {
      markWriterEntered = resolve;
    });
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const oldWriter = withUserProfileAuthorizationLock(characterId, async () => {
      markWriterEntered();
      await writerRelease;
      writeFileSync(lanePath, 'late old private profile');
    });
    await writerEntered;

    const revoke = revokeWebSession(db, { cookies: { eveai_session: token } } as FastifyRequest);
    const concurrentSso = withWebLaneAuthorizationLock(chatId, async () => {
      expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(chatId)).toBeUndefined();
    });
    releaseWriter();
    await oldWriter;
    await revoke;
    await concurrentSso;

    expect(existsSync(lanePath)).toBe(false);
    expect(existsSync(userPath)).toBe(false);
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(characterId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId)).toBeUndefined();
    expect(getLinkedCharacter(db, { userId, chatId })).toBeNull();
  });
});
