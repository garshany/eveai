import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { opaqueTokenCandidates, protectOpaqueToken } from './secret-storage.js';

type AuthRequestType = 'eve_sso' | 'tg_handoff';

interface CreateAuthRequestOptions {
  chatId?: number;
  redirectUrl?: string;
  ttlSeconds: number;
}

export interface AuthRequestRow {
  user_id: number;
  chat_id: number | null;
  type: AuthRequestType;
  redirect_url: string | null;
  requestedScopes: string[] | null;
  consent_version: string | null;
  consent_language: 'ru' | 'en' | null;
  consented_at: string | null;
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
    DELETE FROM auth_requests
    WHERE type = ?
      AND user_id = ?
      AND COALESCE(chat_id, 0) = COALESCE(?, 0)
      AND used_at IS NULL
  `).run(type, userId, options.chatId ?? null);
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
    SELECT user_id, chat_id, type, redirect_url, requested_scopes_json,
           consent_version, consent_language, consented_at
    FROM auth_requests
    WHERE type = ?
      AND state IN (?, ?)
      AND used_at IS NULL
      AND expires_at > datetime('now')
    ORDER BY CASE WHEN state = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(type, protectedToken, legacyToken, protectedToken) as (Omit<AuthRequestRow, 'requestedScopes'> & {
    requested_scopes_json: string | null;
  }) | undefined;
  if (!row) return null;
  return {
    user_id: row.user_id,
    chat_id: row.chat_id,
    type: row.type,
    redirect_url: row.redirect_url,
    requestedScopes: parseRequestedScopes(row.requested_scopes_json),
    consent_version: row.consent_version,
    consent_language: row.consent_language,
    consented_at: row.consented_at,
  };
}

export function recordAuthRequestConsent(
  db: Db,
  type: AuthRequestType,
  token: string,
  consent: {
    version: string;
    language: 'ru' | 'en';
    scopes: readonly string[];
  },
): boolean {
  cleanExpiredAuthRequests(db);
  const [protectedToken, legacyToken] = opaqueTokenCandidates(token, authRequestPurpose(type));
  const result = db.prepare(`
    UPDATE auth_requests
    SET requested_scopes_json = ?, consent_version = ?, consent_language = ?,
        consented_at = datetime('now')
    WHERE type = ?
      AND state IN (?, ?)
      AND used_at IS NULL
      AND consented_at IS NULL
      AND expires_at > datetime('now')
  `).run(
    JSON.stringify([...consent.scopes]),
    consent.version,
    consent.language,
    type,
    protectedToken,
    legacyToken,
  );
  return result.changes === 1;
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

function parseRequestedScopes(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}
