/**
 * Kill watch manager — per-user topic subscriptions.
 * CRUD for kill_watches table. The global feed poller reads current watches
 * for every event, so changes take effect without transport subscriptions.
 */

import type { Db } from '../db/sqlite.js';
// ---------------------------------------------------------------------------
// DB types
// ---------------------------------------------------------------------------

type WatchRow = {
  id: number;
  chat_id: number;
  topic: string;
  label: string;
  created_at: string;
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function addWatch(db: Db, chatId: number, topic: string, label: string): { ok: boolean; error?: string } {
  const existing = db.prepare('SELECT id FROM kill_watches WHERE chat_id = ? AND topic = ?').get(chatId, topic) as { id: number } | undefined;
  if (existing) return { ok: false, error: `Already watching: ${label || topic}` };

  const count = (db.prepare(
    'SELECT COUNT(*) as c FROM kill_watches WHERE chat_id = ?',
  ).get(chatId) as { c: number }).c;
  if (count >= 20) return { ok: false, error: 'Maximum 20 watches per chat. Remove some first.' };

  db.prepare('INSERT INTO kill_watches (chat_id, topic, label) VALUES (?, ?, ?)').run(chatId, topic, label);

  return { ok: true };
}

export function removeWatch(db: Db, chatId: number, topic: string): { ok: boolean; error?: string } {
  const result = db.prepare('DELETE FROM kill_watches WHERE chat_id = ? AND topic = ?').run(chatId, topic);
  if (result.changes === 0) return { ok: false, error: `Not watching: ${topic}` };

  return { ok: true };
}

export function removeAllWatches(db: Db, chatId: number): number {
  const result = db.prepare('DELETE FROM kill_watches WHERE chat_id = ?').run(chatId);
  return result.changes;
}

export function listWatches(db: Db, chatId: number): WatchRow[] {
  return db.prepare('SELECT * FROM kill_watches WHERE chat_id = ? ORDER BY created_at').all(chatId) as WatchRow[];
}
