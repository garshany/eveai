import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { createAuthRequestToken, findPendingAuthRequest, markAuthRequestUsed } from './auth-request.js';

export function createHandoffToken(db: Db, userId: number, chatId: number): string {
  return createAuthRequestToken(db, 'tg_handoff', userId, {
    chatId,
    ttlSeconds: config.web.handoffTtlSeconds,
  });
}

export function consumeHandoffToken(db: Db, token: string): number | null {
  const row = findPendingAuthRequest(db, 'tg_handoff', token);
  if (!row) return null;
  markAuthRequestUsed(db, 'tg_handoff', token);
  return row.user_id;
}
