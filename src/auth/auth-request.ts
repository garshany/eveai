import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { opaqueTokenCandidates, protectOpaqueToken } from './secret-storage.js';

type AuthRequestType = 'eve_sso' | 'tg_handoff';

interface CreateAuthRequestOptions {
  chatId?: number;
  redirectUrl?: string;
  ttlSeconds: number;
}

interface AuthRequestRow {
  user_id: number;
  chat_id: number | null;
  type: AuthRequestType;
}

const USED_AUTH_REQUEST_RETENTION_HOURS = 24;

export function createAuthRequestToken(
  db: Db,
  type: AuthRequestType,
  userId: number,
  options: CreateAuthRequestOptions,
): string {
  cleanExpiredAuthRequests(db);
  const token = randomUUID();
  db.prepare(`
    INSERT INTO auth_requests (state, type, user_id, chat_id, redirect_url, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' seconds'))
  `).run(
    protectOpaqueToken(token, authRequestPurpose(type)),
    type,
    userId,
    options.chatId ?? null,
    options.redirectUrl ?? null,
    options.ttlSeconds,
  );
  return token;
}

export function findPendingAuthRequest(db: Db, type: AuthRequestType, token: string): AuthRequestRow | null {
  cleanExpiredAuthRequests(db);
  const [protectedToken, legacyToken] = opaqueTokenCandidates(token, authRequestPurpose(type));
  const row = db.prepare(`
    SELECT user_id, chat_id, type
    FROM auth_requests
    WHERE type = ?
      AND state IN (?, ?)
      AND used_at IS NULL
      AND expires_at > datetime('now')
    ORDER BY CASE WHEN state = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(type, protectedToken, legacyToken, protectedToken) as AuthRequestRow | undefined;
  return row ?? null;
}

export function markAuthRequestUsed(db: Db, type: AuthRequestType, token: string): void {
  cleanExpiredAuthRequests(db);
  const [protectedToken, legacyToken] = opaqueTokenCandidates(token, authRequestPurpose(type));
  db.prepare(`
    UPDATE auth_requests
    SET used_at = datetime('now')
    WHERE type = ?
      AND state IN (?, ?)
  `).run(type, protectedToken, legacyToken);
}

export function protectLegacyOauthState(state: string): string {
  return protectOpaqueToken(state, 'telegram_oauth_state');
}

export function legacyOauthStateCandidates(state: string): [string, string] {
  return opaqueTokenCandidates(state, 'telegram_oauth_state');
}

export function cleanExpiredAuthRequests(db: Db): void {
  db.prepare(`
    DELETE FROM auth_requests
    WHERE expires_at <= datetime('now')
       OR (used_at IS NOT NULL AND used_at <= datetime('now', '-' || ? || ' hours'))
  `).run(USED_AUTH_REQUEST_RETENTION_HOURS);
}

function authRequestPurpose(type: AuthRequestType): string {
  return `auth_request:${type}`;
}
