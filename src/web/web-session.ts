import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { matchesOpaqueToken, protectOpaqueToken } from '../auth/secret-storage.js';
import {
  resolveUserProfilePath,
  withUserProfileAuthorizationLock,
} from '../eve/user-profile-storage.js';
import { discardRouteMonitor } from '../eve-board/monitor.js';
import { withWebLaneAuthorizationLock } from './web-lane-lock.js';

export const WEB_SESSION_COOKIE = 'eveai_session';
export const WEB_CSRF_COOKIE = 'eveai_csrf';

const WEB_CHAT_ID_START = -2_000_000_000;
const SESSION_PURPOSE = 'web_session';
const CSRF_PURPOSE = 'web_csrf';
const SESSION_CLEANUP_INTERVAL_MS = 60_000;
let lastSessionCleanupAt = 0;
let sessionCleanupInFlight: Promise<void> | null = null;

export interface WebSession {
  userId: number;
  chatId: number;
  csrfHash: string;
}

export interface CreatedWebSession extends WebSession {
  sessionToken: string;
  csrfToken: string;
}

export interface WebSessionCreationAllowance {
  ok: boolean;
  retryAfterSeconds: number;
}

export function evaluateWebSessionCreationAllowance(
  db: Db,
  ipKey: string,
  now = Date.now(),
): WebSessionCreationAllowance {
  const windowMs = config.web.sessionCreationWindowSeconds * 1000;
  const rows = db.prepare(`
    SELECT created_at_ms FROM web_admission_events
    WHERE event_kind = 'session' AND ip_key = ? AND created_at_ms >= ?
    ORDER BY created_at_ms ASC
  `).all(ipKey, now - windowMs) as Array<{ created_at_ms: number }>;
  if (rows.length >= config.web.maxSessionCreationsPerWindow) {
    const oldest = rows[0]?.created_at_ms ?? now;
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

export function resetWebSessionCreationGuardForTests(): void {
  lastSessionCleanupAt = 0;
  sessionCleanupInFlight = null;
}

export function createWebSession(db: Db, ipKey = buildWebClientIpKey('unknown')): CreatedWebSession {
  const sessionToken = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');

  const create = db.transaction((): CreatedWebSession => {
    const user = db.prepare(
      "INSERT INTO users (display_name, created_at, updated_at) VALUES ('Web capsuleer', datetime('now'), datetime('now'))",
    ).run();
    const userId = Number(user.lastInsertRowid);
    const next = db.prepare(
      `SELECT COALESCE(MIN(chat_id) - 1, ?) AS chat_id
       FROM telegram_sessions
       WHERE username = 'web' AND chat_id <= ?`,
    ).get(WEB_CHAT_ID_START, WEB_CHAT_ID_START) as { chat_id: number };
    const chatId = Math.min(next.chat_id, WEB_CHAT_ID_START);

    db.prepare(
      "INSERT INTO telegram_sessions (chat_id, username, last_seen_at) VALUES (?, 'web', datetime('now'))",
    ).run(chatId);
    const csrfHash = protectOpaqueToken(csrfToken, CSRF_PURPOSE);
    db.prepare(`
      INSERT INTO web_sessions (
        session_hash, csrf_hash, user_id, chat_id, created_at, last_seen_at, expires_at
      ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now', '+' || ? || ' hours'))
    `).run(
      protectOpaqueToken(sessionToken, SESSION_PURPOSE),
      csrfHash,
      userId,
      chatId,
      config.web.sessionTtlHours,
    );
    db.prepare(`
      INSERT INTO web_admission_events (event_id, event_kind, user_id, ip_key, cost_units, created_at_ms)
      VALUES (?, 'session', ?, ?, 0, ?)
    `).run(randomUUID(), userId, ipKey, Date.now());

    return { userId, chatId, csrfHash, sessionToken, csrfToken };
  });

  return create.immediate();
}

export function readWebSession(db: Db, request: FastifyRequest): WebSession | null {
  const rawToken = request.cookies[WEB_SESSION_COOKIE];
  if (!rawToken || rawToken.length > 128) return null;
  const row = db.prepare(`
    SELECT user_id, chat_id, csrf_hash
    FROM web_sessions
    WHERE session_hash = ? AND expires_at > datetime('now')
  `).get(protectOpaqueToken(rawToken, SESSION_PURPOSE)) as {
    user_id: number;
    chat_id: number;
    csrf_hash: string;
  } | undefined;
  if (!row) return null;
  db.prepare(`
    UPDATE web_sessions
    SET last_seen_at = datetime('now'), expires_at = datetime('now', '+' || ? || ' hours')
    WHERE session_hash = ?
  `).run(config.web.sessionTtlHours, protectOpaqueToken(rawToken, SESSION_PURPOSE));
  return { userId: row.user_id, chatId: row.chat_id, csrfHash: row.csrf_hash };
}

export function rotateWebCsrf(db: Db, request: FastifyRequest, session: WebSession): string {
  const token = randomBytes(24).toString('base64url');
  const hash = protectOpaqueToken(token, CSRF_PURPOSE);
  const sessionToken = request.cookies[WEB_SESSION_COOKIE];
  if (!sessionToken) throw new Error('Missing web session cookie');
  db.prepare('UPDATE web_sessions SET csrf_hash = ? WHERE session_hash = ?')
    .run(hash, protectOpaqueToken(sessionToken, SESSION_PURPOSE));
  session.csrfHash = hash;
  return token;
}

export function reuseOrRotateWebCsrf(db: Db, request: FastifyRequest, session: WebSession): string {
  const current = request.cookies[WEB_CSRF_COOKIE];
  if (
    current
    && current.length <= 128
    && matchesOpaqueToken(session.csrfHash, current, CSRF_PURPOSE)
  ) {
    return current;
  }
  return rotateWebCsrf(db, request, session);
}

export function setWebSessionCookies(
  reply: FastifyReply,
  input: { sessionToken?: string; csrfToken: string },
): void {
  const common = {
    path: '/',
    secure: webCookiesAreSecure(),
    sameSite: 'lax' as const,
    maxAge: config.web.sessionTtlHours * 60 * 60,
  };
  if (input.sessionToken) {
    reply.setCookie(WEB_SESSION_COOKIE, input.sessionToken, {
      ...common,
      httpOnly: true,
    });
  }
  reply.setCookie(WEB_CSRF_COOKIE, input.csrfToken, {
    ...common,
    httpOnly: false,
    sameSite: 'strict',
  });
}

export function clearWebSessionCookies(reply: FastifyReply): void {
  const options = { path: '/', secure: webCookiesAreSecure() };
  reply.clearCookie(WEB_SESSION_COOKIE, options);
  reply.clearCookie(WEB_CSRF_COOKIE, options);
}

export async function revokeWebSession(db: Db, request: FastifyRequest): Promise<void> {
  const token = request.cookies[WEB_SESSION_COOKIE];
  if (!token) return;
  const row = db.prepare(`
    SELECT user_id, chat_id
    FROM web_sessions
    WHERE session_hash = ?
  `).get(protectOpaqueToken(token, SESSION_PURPOSE)) as {
    user_id: number;
    chat_id: number;
  } | undefined;
  if (row) await purgeBrowserLane(db, row.chat_id);
}

export function verifyWebMutation(request: FastifyRequest, session: WebSession): boolean {
  const origin = normalizeOrigin(request.headers.origin);
  const configuredOrigin = normalizeOrigin(config.web.baseUrl);
  if (!origin || !configuredOrigin || origin !== configuredOrigin) return false;
  const csrf = request.headers['x-csrf-token'];
  if (typeof csrf !== 'string' || csrf.length > 128) return false;
  return matchesOpaqueToken(session.csrfHash, csrf, CSRF_PURPOSE);
}

export function verifyWebSessionCreation(request: FastifyRequest): boolean {
  const origin = normalizeOrigin(request.headers.origin);
  const configuredOrigin = normalizeOrigin(config.web.baseUrl);
  return Boolean(origin && configuredOrigin && origin === configuredOrigin);
}

export async function cleanExpiredWebSessions(
  db: Db,
  options: { force?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  if (sessionCleanupInFlight) return sessionCleanupInFlight;
  if (!options.force && now - lastSessionCleanupAt < SESSION_CLEANUP_INTERVAL_MS) return;
  lastSessionCleanupAt = now;
  sessionCleanupInFlight = runExpiredWebSessionCleanup(db).finally(() => {
    sessionCleanupInFlight = null;
  });
  return sessionCleanupInFlight;
}

async function runExpiredWebSessionCleanup(db: Db): Promise<void> {
  const expired = db.prepare(`
    SELECT user_id, chat_id
    FROM web_sessions session
    WHERE expires_at <= datetime('now')
      AND NOT EXISTS (
        SELECT 1 FROM web_agent_requests request
        WHERE request.user_id = session.user_id
          AND request.chat_id = session.chat_id
          AND request.status IN ('queued', 'running')
      )
    ORDER BY expires_at ASC
    LIMIT 20
  `).all() as Array<{ user_id: number; chat_id: number }>;
  for (const row of expired) await purgeBrowserLane(db, row.chat_id);
}

async function purgeBrowserLane(db: Db, chatId: number): Promise<void> {
  await withWebLaneAuthorizationLock(chatId, async () => {
    const lane = db.prepare('SELECT user_id FROM web_sessions WHERE chat_id = ?')
      .get(chatId) as { user_id: number } | undefined;
    if (!lane) return;
    const userId = lane.user_id;
    discardRouteMonitor(chatId);
    const linkedCharacters = db.prepare(`
      SELECT character_id FROM eve_character_links WHERE chat_id = ? OR user_id = ?
      UNION
      SELECT character_id FROM eve_accounts WHERE user_id = ?
    `).all(chatId, userId, userId) as Array<{ character_id: number }>;
    const characterIds = [...new Set(linkedCharacters.map((entry) => entry.character_id))].sort((a, b) => a - b);

    await withCharacterAuthorizationLocks(characterIds, async () => {
      const purge = db.transaction((): boolean => {
        const threads = db.prepare(`
          SELECT thread_id FROM agent_threads WHERE chat_id = ? AND user_id = ?
        `).all(chatId, userId) as Array<{ thread_id: string }>;
        for (const thread of threads) {
          db.prepare('DELETE FROM web_agent_requests WHERE thread_id = ?').run(thread.thread_id);
          db.prepare('DELETE FROM thread_summaries WHERE thread_id = ?').run(thread.thread_id);
          db.prepare('DELETE FROM messages WHERE thread_id = ?').run(thread.thread_id);
          db.prepare('DELETE FROM thread_artifacts WHERE thread_id = ?').run(thread.thread_id);
          db.prepare('DELETE FROM agent_threads WHERE thread_id = ?').run(thread.thread_id);
        }

        db.prepare('DELETE FROM route_monitor_kill_dedup WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM route_monitors WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM kill_watches WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM eve_kill_notification_dedup WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM eve_character_links WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM auth_requests WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM web_sessions WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM telegram_sessions WHERE chat_id = ?').run(chatId);

        const hasOtherIdentity = Boolean(
          db.prepare('SELECT 1 FROM web_sessions WHERE user_id = ? LIMIT 1').get(userId)
          || db.prepare('SELECT 1 FROM telegram_accounts WHERE user_id = ? LIMIT 1').get(userId)
          || db.prepare('SELECT 1 FROM discord_accounts WHERE user_id = ? LIMIT 1').get(userId)
          || db.prepare('SELECT 1 FROM cli_accounts WHERE user_id = ? LIMIT 1').get(userId),
        );
        if (hasOtherIdentity) return false;

        db.prepare('DELETE FROM heartbeat_config WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM intel_notes WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM auth_requests WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM eve_character_links WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM eve_accounts WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
        return true;
      });
      const removedUser = purge.immediate();

      for (const characterId of characterIds) {
        try {
          rmSync(resolveUserProfilePath({ userId, chatId }, characterId), { force: true });
          if (removedUser) rmSync(resolveUserProfilePath({ userId }, characterId), { force: true });
        } catch {
          // Database revocation is authoritative even if best-effort artifact
          // removal is blocked by an operational filesystem problem.
        }
      }
    });
  });
}

export function buildWebClientIpKey(ip: string): string {
  const normalized = normalizeClientIp(ip);
  const secret = config.auth.secretKey.trim() || 'eveai-local-ip-key';
  return `ip1:${createHmac('sha256', secret).update(normalized).digest('base64url')}`;
}

async function withCharacterAuthorizationLocks<T>(
  characterIds: number[],
  action: () => Promise<T>,
): Promise<T> {
  const acquire = (index: number): Promise<T> => {
    if (index >= characterIds.length) return action();
    return withUserProfileAuthorizationLock(characterIds[index]!, () => acquire(index + 1));
  };
  return await acquire(0);
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizeClientIp(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:') && /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
    return trimmed.slice(7);
  }
  if (/^[0-9a-f:.]{2,64}$/.test(trimmed)) return trimmed;
  return 'invalid';
}

function webCookiesAreSecure(): boolean {
  try {
    return new URL(config.web.baseUrl).protocol === 'https:';
  } catch {
    return process.env.NODE_ENV === 'production';
  }
}
