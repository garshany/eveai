import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { opaqueTokenCandidates, protectOpaqueToken } from './secret-storage.js';

export interface TelegramLoginData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

const MAX_AUTH_AGE_SECONDS = 300;
const USED_LOGIN_NONCE_RETENTION_HOURS = 24;

export function verifyTelegramLogin(data: TelegramLoginData): boolean {
  const { hash, ...rest } = data;

  const checkString = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = createHash('sha256').update(config.telegram.botToken).digest();
  const hmac = createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (!safeEqualHex(hmac, hash)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now - data.auth_date > MAX_AUTH_AGE_SECONDS) return false;

  return true;
}

export function createTelegramLoginNonce(db: Db, ttlSeconds = MAX_AUTH_AGE_SECONDS): string {
  cleanExpiredTelegramLoginAttempts(db);
  const nonce = randomUUID();
  db.prepare(`
    INSERT INTO telegram_login_attempts (nonce, expires_at)
    VALUES (?, datetime('now', '+' || ? || ' seconds'))
  `).run(protectOpaqueToken(nonce, 'telegram_login_nonce'), ttlSeconds);
  return nonce;
}

export function consumeTelegramLoginNonce(db: Db, nonce: string): boolean {
  cleanExpiredTelegramLoginAttempts(db);
  const [protectedNonce, legacyNonce] = opaqueTokenCandidates(nonce, 'telegram_login_nonce');
  const result = db.prepare(`
    UPDATE telegram_login_attempts
    SET used_at = datetime('now')
    WHERE nonce IN (?, ?)
      AND used_at IS NULL
      AND expires_at > datetime('now')
  `).run(protectedNonce, legacyNonce);
  return result.changes > 0;
}

export function cleanExpiredTelegramLoginAttempts(db: Db): void {
  db.prepare(`
    DELETE FROM telegram_login_attempts
    WHERE expires_at <= datetime('now')
       OR (used_at IS NOT NULL AND used_at <= datetime('now', '-' || ? || ' hours'))
  `).run(USED_LOGIN_NONCE_RETENTION_HOURS);
}

export function parseTelegramLoginQuery(
  query: Record<string, string>,
): TelegramLoginData | null {
  const id = Number(query.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (!query.hash) return null;
  if (!query.auth_date) return null;

  return {
    id,
    first_name: query.first_name ?? '',
    last_name: query.last_name || undefined,
    username: query.username || undefined,
    photo_url: query.photo_url || undefined,
    auth_date: Number(query.auth_date),
    hash: query.hash,
  };
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
