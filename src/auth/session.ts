import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { opaqueTokenCandidates, protectOpaqueToken } from './secret-storage.js';

export function createWebSession(db: Db, userId: number): string {
  cleanExpiredSessions(db);
  const sessionId = randomUUID();
  const ttlHours = config.web.sessionTtlHours;
  db.prepare(
    "INSERT INTO web_sessions (session_id, user_id, expires_at, created_at) VALUES (?, ?, datetime('now', '+' || ? || ' hours'), datetime('now'))",
  ).run(protectOpaqueToken(sessionId, 'web_session'), userId, ttlHours);
  return sessionId;
}

export function deleteWebSession(db: Db, sessionId: string): void {
  const [protectedSessionId, legacySessionId] = opaqueTokenCandidates(sessionId, 'web_session');
  db.prepare('DELETE FROM web_sessions WHERE session_id IN (?, ?)').run(protectedSessionId, legacySessionId);
}

export function cleanExpiredSessions(db: Db): void {
  db.prepare("DELETE FROM web_sessions WHERE expires_at <= datetime('now')").run();
}

export function resolveWebSessionUser(db: Db, sessionId: string): number | null {
  cleanExpiredSessions(db);
  const [protectedSessionId, legacySessionId] = opaqueTokenCandidates(sessionId, 'web_session');
  const row = db.prepare(`
    SELECT user_id
    FROM web_sessions
    WHERE session_id IN (?, ?)
      AND expires_at > datetime('now')
    ORDER BY CASE WHEN session_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(protectedSessionId, legacySessionId, protectedSessionId) as { user_id: number } | undefined;
  return row?.user_id ?? null;
}

export const SESSION_COOKIE_NAME = 'eve_session';

export function buildSessionCookie(
  sessionId: string,
  maxAgeHours: number,
  requestHeaders?: Record<string, string | string[] | undefined>,
): string {
  const maxAge = maxAgeHours * 3600;
  return buildCookie(sessionId, maxAge, requestHeaders);
}

export function buildLogoutCookie(requestHeaders?: Record<string, string | string[] | undefined>): string {
  return buildCookie('', 0, requestHeaders);
}

function buildCookie(
  value: string,
  maxAgeSeconds: number,
  requestHeaders?: Record<string, string | string[] | undefined>,
): string {
  const attributes = [
    `Path=/`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (shouldUseSecureCookies(requestHeaders)) {
    attributes.push('Secure');
  }

  attributes.push(`Max-Age=${maxAgeSeconds}`);

  return `${SESSION_COOKIE_NAME}=${value}; ${attributes.join('; ')}`;
}

function shouldUseSecureCookies(requestHeaders?: Record<string, string | string[] | undefined>): boolean {
  try {
    if (new URL(config.web.baseUrl).protocol === 'https:') {
      return true;
    }
  } catch {
    // fall through
  }

  const forwardedProto = requestHeaders?.['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return typeof proto === 'string' && proto.split(',').some((value) => value.trim() === 'https');
}
