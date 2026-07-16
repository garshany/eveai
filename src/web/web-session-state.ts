import type { Db } from '../db/sqlite.js';

export type WebSessionLaneState = {
  userId: number;
  active: boolean;
};

export function getWebSessionLaneState(db: Db, chatId: number): WebSessionLaneState | null {
  const row = db.prepare(`
    SELECT user_id, expires_at > datetime('now') AS active
    FROM web_sessions
    WHERE chat_id = ?
    LIMIT 1
  `).get(chatId) as { user_id: number; active: number } | undefined;
  return row ? { userId: row.user_id, active: row.active === 1 } : null;
}

export function isActiveWebSessionLane(db: Db, chatId: number): boolean {
  return getWebSessionLaneState(db, chatId)?.active === true;
}
