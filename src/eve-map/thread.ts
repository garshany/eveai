/**
 * The Perimeter chat thread.
 *
 * The map's assistant panel is not a toast stack — it is an ordinary
 * `agent_threads` row marked `kind = 'perimeter'`. Everything the workspace
 * already built for chat therefore applies unchanged: history survives reloads
 * and restarts, the request queue and quota accounting are shared, and anything
 * said on the map can be continued in the full chat screen.
 *
 * The one addition is `meta_json`: an unprompted advisory records which rule
 * produced it and what it points at, so the message stays clickable and the map
 * can fly to the system the sentence is about.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { Advisory } from './advisor.js';

export type PerimeterMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  meta: AdvisoryMeta | null;
};

export type AdvisoryMeta = {
  kind: 'advisory';
  rule: string;
  severity: 'info' | 'warn' | 'danger';
  systemId: number | null;
  killmailId: number | null;
  repeats: number;
  /** Set when the model wrote the prose instead of the rule template. */
  authored: 'rule' | 'model';
};

/**
 * One Perimeter thread per (chat lane, character). Switching the active
 * character opens a different thread rather than mixing two pilots' warnings
 * into one transcript.
 */
export function getOrCreatePerimeterThread(
  db: Db,
  chatId: number,
  userId: number,
  characterId: number | null,
): string {
  const existing = db.prepare(`
    SELECT thread_id FROM agent_threads
    WHERE chat_id = ? AND user_id = ? AND kind = 'perimeter'
      AND (character_id IS ? OR character_id = ?)
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(chatId, userId, characterId, characterId) as { thread_id: string } | undefined;
  if (existing) return existing.thread_id;

  const threadId = randomUUID();
  db.prepare(`
    INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id, kind)
    VALUES (?, ?, ?, ?, 'perimeter')
  `).run(threadId, chatId, characterId, userId);
  return threadId;
}

/**
 * Begin a new Perimeter conversation.
 *
 * Deliberately not a delete. The advisor writes into this thread without being
 * asked, so removing rows would race with it; and the warnings a pilot received
 * during a flight are evidence, not clutter. `getOrCreatePerimeterThread` picks
 * the most recently updated thread, so the new one simply becomes the active
 * one and the old transcript stays reachable.
 */
export function startNewPerimeterThread(
  db: Db,
  chatId: number,
  userId: number,
  characterId: number | null,
): string {
  const threadId = randomUUID();
  db.prepare(`
    INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id, kind)
    VALUES (?, ?, ?, ?, 'perimeter')
  `).run(threadId, chatId, characterId, userId);
  return threadId;
}

/** Append an unprompted advisory as an assistant message. */
export function appendAdvisory(
  db: Db,
  threadId: string,
  advisory: Advisory,
  locale: 'ru' | 'en',
  authored: 'rule' | 'model' = 'rule',
  overrideText?: string,
): PerimeterMessage {
  const meta: AdvisoryMeta = {
    kind: 'advisory',
    rule: advisory.rule,
    severity: advisory.severity,
    systemId: advisory.systemId,
    killmailId: advisory.killmailId,
    repeats: advisory.repeats,
    authored,
  };
  const content = overrideText ?? advisory.text[locale];
  const result = db.prepare(`
    INSERT INTO messages (thread_id, role, content, meta_json)
    VALUES (?, 'assistant', ?, ?)
  `).run(threadId, content, JSON.stringify(meta));
  db.prepare("UPDATE agent_threads SET updated_at = datetime('now') WHERE thread_id = ?").run(threadId);

  return {
    id: Number(result.lastInsertRowid),
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
    meta,
  };
}

export function readPerimeterHistory(
  db: Db,
  threadId: string,
  limit = 50,
): PerimeterMessage[] {
  const rows = db.prepare(`
    SELECT id, role, content, meta_json, created_at FROM messages
    WHERE thread_id = ? AND role IN ('user', 'assistant')
    ORDER BY id DESC
    LIMIT ?
  `).all(threadId, Math.max(1, Math.min(200, limit))) as Array<{
    id: number;
    role: 'user' | 'assistant';
    content: string;
    meta_json: string | null;
    created_at: string;
  }>;
  return rows.reverse().map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    meta: parseMeta(row.meta_json),
  }));
}

/**
 * The conversation list titles a thread from its first *user* message, and a
 * Perimeter thread routinely opens with an assistant warning. Without this the
 * sidebar would show "Новый диалог" for every flight.
 */
export function perimeterThreadTitle(
  db: Db,
  threadId: string,
  locale: 'ru' | 'en',
): string {
  const row = db.prepare(`
    SELECT content FROM messages WHERE thread_id = ? AND role = 'user'
    ORDER BY id ASC LIMIT 1
  `).get(threadId) as { content: string } | undefined;
  if (row?.content.trim()) return row.content.trim().slice(0, 72);
  return locale === 'ru' ? 'Периметр' : 'Perimeter';
}

function parseMeta(raw: string | null): AdvisoryMeta | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.kind !== 'advisory') return null;
    const severity = record.severity;
    return {
      kind: 'advisory',
      rule: typeof record.rule === 'string' ? record.rule : 'unknown',
      severity: severity === 'danger' || severity === 'warn' ? severity : 'info',
      systemId: typeof record.systemId === 'number' ? record.systemId : null,
      killmailId: typeof record.killmailId === 'number' ? record.killmailId : null,
      repeats: typeof record.repeats === 'number' ? record.repeats : 0,
      authored: record.authored === 'model' ? 'model' : 'rule',
    };
  } catch {
    return null;
  }
}
