/**
 * Kill watch manager — per-user topic subscriptions.
 * CRUD for kill_watches table. Notifications handled by zkb-ws.ts.
 */

import type { Db } from '../db/sqlite.js';
import { subscribeTopics, unsubscribeTopics } from './zkb-ws.js';

const LOG = '[kill-watch]';

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

  // Auto-created route-monitor watches (label '[route] …') are bounded by the
  // route length and cleaned up when the monitor stops, so they must not count
  // against the user's manual-watch budget.
  const count = (db.prepare(
    "SELECT COUNT(*) as c FROM kill_watches WHERE chat_id = ? AND label NOT LIKE '[route] %'",
  ).get(chatId) as { c: number }).c;
  if (count >= 20) return { ok: false, error: 'Maximum 20 watches per chat. Remove some first.' };

  db.prepare('INSERT INTO kill_watches (chat_id, topic, label) VALUES (?, ?, ?)').run(chatId, topic, label);

  subscribeTopics([topic]);
  console.log(`${LOG} added: chat=${chatId} topic=${topic} label=${label}`);
  return { ok: true };
}

export function removeWatch(db: Db, chatId: number, topic: string): { ok: boolean; error?: string } {
  const result = db.prepare('DELETE FROM kill_watches WHERE chat_id = ? AND topic = ?').run(chatId, topic);
  if (result.changes === 0) return { ok: false, error: `Not watching: ${topic}` };

  // Unsubscribe if no other chat watches this topic
  const others = db.prepare('SELECT id FROM kill_watches WHERE topic = ? LIMIT 1').get(topic) as { id: number } | undefined;
  if (!others) {
    unsubscribeTopics([topic]);
  }
  console.log(`${LOG} removed: chat=${chatId} topic=${topic}`);
  return { ok: true };
}

export function removeAllWatches(db: Db, chatId: number): number {
  const watches = db.prepare('SELECT topic FROM kill_watches WHERE chat_id = ?').all(chatId) as Array<{ topic: string }>;
  const result = db.prepare('DELETE FROM kill_watches WHERE chat_id = ?').run(chatId);

  // Unsubscribe topics that no longer have watchers
  for (const { topic } of watches) {
    const others = db.prepare('SELECT id FROM kill_watches WHERE topic = ? LIMIT 1').get(topic) as { id: number } | undefined;
    if (!others) unsubscribeTopics([topic]);
  }

  console.log(`${LOG} removed all: chat=${chatId} count=${result.changes}`);
  return result.changes;
}

export function listWatches(db: Db, chatId: number): WatchRow[] {
  return db.prepare('SELECT * FROM kill_watches WHERE chat_id = ? ORDER BY created_at').all(chatId) as WatchRow[];
}
