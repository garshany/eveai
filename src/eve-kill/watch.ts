/**
 * Kill watch manager — per-user WS topic subscriptions with Telegram notifications.
 *
 * Users subscribe via kill_watch tool: "следи за игроком X", "следи за системой Uedama".
 * When a matching kill arrives via WS, bot sends a Telegram message.
 * Watches persist in SQLite (kill_watches table) and survive restarts.
 */

import type { Db } from '../db/sqlite.js';
import type { EveKillKillmail } from './types.js';
import { eveKillWs } from './ws.js';

const LOG = '[kill-watch]';

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

type WatchRow = {
  id: number;
  chat_id: number;
  topic: string;
  label: string;
  created_at: string;
};

export function addWatch(db: Db, chatId: number, topic: string, label: string): { ok: boolean; error?: string } {
  const existing = db.prepare('SELECT id FROM kill_watches WHERE chat_id = ? AND topic = ?').get(chatId, topic) as { id: number } | undefined;
  if (existing) return { ok: false, error: `Already watching: ${label || topic}` };

  const count = (db.prepare('SELECT COUNT(*) as c FROM kill_watches WHERE chat_id = ?').get(chatId) as { c: number }).c;
  if (count >= 20) return { ok: false, error: 'Maximum 20 watches per chat. Remove some first.' };

  db.prepare('INSERT INTO kill_watches (chat_id, topic, label) VALUES (?, ?, ?)').run(chatId, topic, label);

  // Subscribe WS topic
  eveKillWs.subscribe([topic]);
  console.log(`${LOG} added: chat=${chatId} topic=${topic} label=${label}`);
  return { ok: true };
}

export function removeWatch(db: Db, chatId: number, topic: string): { ok: boolean; error?: string } {
  const result = db.prepare('DELETE FROM kill_watches WHERE chat_id = ? AND topic = ?').run(chatId, topic);
  if (result.changes === 0) return { ok: false, error: `Not watching: ${topic}` };

  // Unsubscribe if no other chat watches this topic
  const others = db.prepare('SELECT id FROM kill_watches WHERE topic = ? LIMIT 1').get(topic) as { id: number } | undefined;
  if (!others) {
    eveKillWs.unsubscribe([topic]);
  }
  console.log(`${LOG} removed: chat=${chatId} topic=${topic}`);
  return { ok: true };
}

export function removeAllWatches(db: Db, chatId: number): number {
  const result = db.prepare('DELETE FROM kill_watches WHERE chat_id = ?').run(chatId);
  // Unsubscribe topics that no longer have any watchers
  refreshWsSubscriptions(db);
  console.log(`${LOG} removed all: chat=${chatId} count=${result.changes}`);
  return result.changes;
}

export function listWatches(db: Db, chatId: number): WatchRow[] {
  return db.prepare('SELECT * FROM kill_watches WHERE chat_id = ? ORDER BY created_at').all(chatId) as WatchRow[];
}

// ---------------------------------------------------------------------------
// WS → Telegram notification dispatcher
// ---------------------------------------------------------------------------

type NotifySender = (chatId: number, text: string) => void;

let notifySender: NotifySender | null = null;
let watchDb: Db | null = null;

export function initWatchNotifications(db: Db, sender: NotifySender): void {
  watchDb = db;
  notifySender = sender;

  // Load all watches from DB and subscribe WS topics
  refreshWsSubscriptions(db);

  // Register WS handler
  eveKillWs.onKillmail(handleKillmailForWatches);
  console.log(`${LOG} notification dispatcher initialized`);
}

function handleKillmailForWatches(km: EveKillKillmail): void {
  if (!watchDb || !notifySender) return;

  // Check which topics this killmail matches
  const matchingTopics: string[] = [];
  if (km.system_id) matchingTopics.push(`system.${km.system_id}`);
  if (km.region_id) matchingTopics.push(`region.${km.region_id}`);

  const victimCharId = km.victim?.character_id;
  if (victimCharId) {
    matchingTopics.push(`victim.${victimCharId}`);
  }

  // Check attackers
  for (const atk of km.attackers ?? []) {
    if (atk.character_id) matchingTopics.push(`attacker.${atk.character_id}`);
  }

  if (matchingTopics.length === 0) return;

  // Find watchers for these topics
  const placeholders = matchingTopics.map(() => '?').join(',');
  const watchers = watchDb.prepare(
    `SELECT DISTINCT chat_id, topic, label FROM kill_watches WHERE topic IN (${placeholders})`,
  ).all(...matchingTopics) as Array<{ chat_id: number; topic: string; label: string }>;

  if (watchers.length === 0) return;

  // Build notification message
  const value = km.total_value ? `${Math.round(km.total_value / 1_000_000)}M ISK` : '?';
  const victim = km.victim;
  const victimName = victim?.character_name ?? victim?.corporation_name ?? '?';
  const shipName = victim?.ship_name ?? '?';
  const systemName = km.system_name ?? `ID:${km.system_id ?? '?'}`;
  const url = `https://eve-kill.com/kill/${km.killmail_id}`;

  const text = `🔴 Kill Alert!\n${victimName} lost ${shipName} in ${systemName}\nValue: ${value}\n${url}`;

  // Send to each unique chat
  const sentChats = new Set<number>();
  for (const w of watchers) {
    if (sentChats.has(w.chat_id)) continue;
    sentChats.add(w.chat_id);
    try {
      notifySender(w.chat_id, text);
    } catch (err) {
      console.error(`${LOG} failed to notify chat=${w.chat_id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// WS topic sync
// ---------------------------------------------------------------------------

function refreshWsSubscriptions(db: Db): void {
  const rows = db.prepare('SELECT DISTINCT topic FROM kill_watches').all() as Array<{ topic: string }>;
  const dbTopics = new Set(rows.map((r) => r.topic));

  // Subscribe topics from DB that aren't active
  const currentTopics = new Set(eveKillWs.getActiveTopics());
  const toSubscribe = [...dbTopics].filter((t) => !currentTopics.has(t));
  const toUnsubscribe = [...currentTopics].filter((t) => t !== 'all' && !dbTopics.has(t));

  if (toSubscribe.length > 0) {
    eveKillWs.subscribe(toSubscribe);
    console.log(`${LOG} restored ${toSubscribe.length} subscriptions from DB`);
  }
  if (toUnsubscribe.length > 0) {
    eveKillWs.unsubscribe(toUnsubscribe);
    console.log(`${LOG} cleaned ${toUnsubscribe.length} stale subscriptions`);
  }
}
