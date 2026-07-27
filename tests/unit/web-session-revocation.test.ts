import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const PROFILE_DIR = '/tmp/eve-agent-web-session-revocation-tests';

vi.mock('../../src/config.js', () => ({
  config: {
    auth: {
      secretKey: 'eve-agent-web-session-revocation-tests',
    },
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

import { encryptStoredSecret } from '../../src/auth/secret-storage.js';
import {
  resolveUserProfilePath,
  withUserProfileAuthorizationLock,
} from '../../src/eve/user-profile-storage.js';
import {
  cleanExpiredWebSessions,
  createWebSession,
  revokeWebSession,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';
import { getLinkedCharacter, linkCharacterToChat } from '../../src/eve/sso.js';
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

function insertEveAccount(characterId: number, userId: number | null): void {
  db.prepare(`
    INSERT INTO eve_accounts (
      character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
    ) VALUES (?, 'Pilot', ?, ?, datetime('now', '+1 hour'), ?, ?)
  `).run(
    characterId,
    encryptStoredSecret(`access-${characterId}`, 'eve_access_token'),
    encryptStoredSecret(`refresh-${characterId}`, 'eve_refresh_token'),
    JSON.stringify(['esi-location.read_location.v1']),
    userId,
  );
}

function sessionRequest(sessionToken: string): FastifyRequest {
  return { cookies: { [WEB_SESSION_COOKIE]: sessionToken } } as FastifyRequest;
}

describe('browser session revocation', () => {
  it('purges an expired browser monitor before startup restoration can resume it', async () => {
    const userId = 10;
    const chatId = -2_000_000_010;
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (?, 'Expired capsuleer')").run(userId);
    // FK regression guard: user_model_settings references users without
    // CASCADE, so the purge must delete the settings row before the user row.
    db.prepare(`
      INSERT INTO user_model_settings (user_id, model, reasoning_effort, verbosity)
      VALUES (?, 'gpt-5.6-luna', 'low', 'high')
    `).run(userId);
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
    expect(db.prepare('SELECT 1 FROM user_model_settings WHERE user_id = ?').get(userId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId)).toBeUndefined();
  });

  it('keeps the persistent identity and its data when a linked user logs out', async () => {
    const session = createWebSession(db);
    const characterId = 7001;
    insertEveAccount(characterId, session.userId);
    linkCharacterToChat(db, { userId: session.userId, chatId: session.chatId }, characterId);
    db.prepare('INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id) VALUES (?, ?, ?, ?)')
      .run('thread-kept-01', session.chatId, characterId, session.userId);

    const lanePath = resolveUserProfilePath({ userId: session.userId, chatId: session.chatId }, characterId);
    const userPath = resolveUserProfilePath({ userId: session.userId }, characterId);
    writeFileSync(lanePath, 'private lane profile');
    writeFileSync(userPath, 'private user profile');

    await revokeWebSession(db, sessionRequest(session.sessionToken));

    // Only the login token is revoked: the user, the character and every
    // artifact survive so the next SSO sign-in reattaches them.
    expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(session.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(session.userId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(characterId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(session.chatId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM agent_threads WHERE thread_id = ?').get('thread-kept-01')).toBeDefined();
    expect(existsSync(lanePath)).toBe(true);
    expect(existsSync(userPath)).toBe(true);
    expect(getLinkedCharacter(db, { userId: session.userId, chatId: session.chatId })?.characterId)
      .toBe(characterId);
  });

  it('discards the route monitor but keeps identity data when a linked user logs out', async () => {
    const session = createWebSession(db);
    const characterId = 7002;
    insertEveAccount(characterId, session.userId);
    linkCharacterToChat(db, { userId: session.userId, chatId: session.chatId }, characterId);
    db.prepare('INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id) VALUES (?, ?, ?, ?)')
      .run('thread-kept-02', session.chatId, characterId, session.userId);
    db.prepare(`
      INSERT INTO route_monitors (chat_id, character_id, origin_id, destination_id, route_systems)
      VALUES (?, ?, 30000142, 30002187, '[30000142,30002187]')
    `).run(session.chatId, characterId);

    await revokeWebSession(db, sessionRequest(session.sessionToken));

    // Monitors are session-scoped: they go with the session even though the
    // persistent identity and its data survive.
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = ?').get(session.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(session.userId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(characterId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM agent_threads WHERE thread_id = ?').get('thread-kept-02')).toBeDefined();
  });

  it('discards the route monitor of a persistent user when the session expires', async () => {
    const session = createWebSession(db);
    const characterId = 7003;
    insertEveAccount(characterId, session.userId);
    linkCharacterToChat(db, { userId: session.userId, chatId: session.chatId }, characterId);
    db.prepare('INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id) VALUES (?, ?, ?, ?)')
      .run('thread-kept-03', session.chatId, characterId, session.userId);
    db.prepare(`
      INSERT INTO route_monitors (chat_id, character_id, origin_id, destination_id, route_systems)
      VALUES (?, ?, 30000142, 30002187, '[30000142,30002187]')
    `).run(session.chatId, characterId);
    db.prepare("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE chat_id = ?")
      .run(session.chatId);

    await cleanExpiredWebSessions(db, { force: true });

    expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(session.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM route_monitors WHERE chat_id = ?').get(session.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(session.userId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM eve_accounts WHERE character_id = ?').get(characterId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM agent_threads WHERE thread_id = ?').get('thread-kept-03')).toBeDefined();
  });

  it('waits for an in-flight profile writer and then removes every anonymous browser-only artifact', async () => {
    const session = createWebSession(db);
    const characterId = 7001;
    // A lane-scoped link without a user_id is anonymous: the guest has no
    // persistent identity to return to, so revocation wipes the lane.
    insertEveAccount(characterId, null);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)')
      .run(session.chatId, characterId);

    const lanePath = resolveUserProfilePath({ userId: session.userId, chatId: session.chatId }, characterId);
    const userPath = resolveUserProfilePath({ userId: session.userId }, characterId);
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

    const revoke = revokeWebSession(db, sessionRequest(session.sessionToken));
    const concurrentSso = withWebLaneAuthorizationLock(session.chatId, async () => {
      expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(session.chatId)).toBeUndefined();
    });
    releaseWriter();
    await oldWriter;
    await revoke;
    await concurrentSso;

    expect(existsSync(lanePath)).toBe(false);
    expect(existsSync(userPath)).toBe(false);
    expect(db.prepare('SELECT 1 FROM eve_character_links WHERE character_id = ?').get(characterId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM web_sessions WHERE chat_id = ?').get(session.chatId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(session.userId)).toBeUndefined();
    expect(getLinkedCharacter(db, { userId: session.userId, chatId: session.chatId })).toBeNull();
  });
});
