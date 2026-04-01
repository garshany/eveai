/**
 * Kill watch poller — polls EVE-KILL /api/killlist REST for watched topics.
 * Replaces unreliable WS as the primary notification source.
 *
 * Every POLL_INTERVAL_MS:
 *   1. Group watches by topic type (system, character, etc.)
 *   2. Poll /api/killlist for each unique entity
 *   3. Compare killmail_ids with last_seen
 *   4. Send Telegram alerts for new kills
 */

import type { Db } from '../db/sqlite.js';
import { getKilllist } from './client.js';
import type { KilllistItem } from './client.js';

const LOG = '[kill-poll]';
const POLL_INTERVAL_MS = 60_000; // 1 minute
const MAX_KILL_AGE_MS = 15 * 60 * 1000; // Skip kills older than 15 min

type NotifySender = (chatId: number, text: string) => void;

// last_seen killmail_id per topic — persisted in DB
const lastSeen = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollDb: Db | null = null;
let pollSender: NotifySender | null = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startKillPoller(db: Db, sender: NotifySender): void {
  pollDb = db;
  pollSender = sender;

  // Load last_seen from DB
  ensureLastSeenTable(db);
  const rows = db.prepare('SELECT topic, last_killmail_id FROM kill_watch_state').all() as Array<{ topic: string; last_killmail_id: number }>;
  for (const r of rows) lastSeen.set(r.topic, r.last_killmail_id);

  console.log(`${LOG} starting poller (interval=${POLL_INTERVAL_MS}ms, ${lastSeen.size} saved states)`);

  // First poll immediately, then every interval
  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

export function stopKillPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log(`${LOG} stopped`);
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

async function pollOnce(): Promise<void> {
  if (!pollDb || !pollSender) return;

  // Get all unique topics from watches
  const watches = pollDb.prepare('SELECT DISTINCT topic, label FROM kill_watches').all() as Array<{ topic: string; label: string }>;
  if (watches.length === 0) return;

  // Group by topic → poll each
  const topicLabels = new Map(watches.map((w) => [w.topic, w.label]));

  for (const [topic] of topicLabels) {
    try {
      await pollTopic(pollDb, topic);
    } catch (err) {
      console.error(`${LOG} poll error for ${topic}:`, (err as Error).message);
    }
  }
}

async function pollTopic(db: Db, topic: string): Promise<void> {
  const params = topicToKilllistParams(topic);
  if (!params) return;

  const result = await getKilllist(db, { ...params, limit: 10 }, 30);
  if (!result.ok || result.data.length === 0) return;

  const prev = lastSeen.get(topic) ?? 0;
  const newKills = result.data.filter((km) => km.killmail_id > prev);
  if (newKills.length === 0) return;

  // Update last_seen to highest ID
  const maxId = Math.max(...newKills.map((km) => km.killmail_id));
  lastSeen.set(topic, maxId);
  saveLastSeen(db, topic, maxId);

  // Filter out old kills (server may return kills from cache)
  const fresh = newKills.filter((km) => {
    if (!km.killmail_time) return true; // no time = assume fresh
    return Date.now() - new Date(km.killmail_time).getTime() < MAX_KILL_AGE_MS;
  });

  if (fresh.length === 0) return;

  // Find which chats watch this topic
  const chatIds = (db.prepare('SELECT DISTINCT chat_id FROM kill_watches WHERE topic = ?').all(topic) as Array<{ chat_id: number }>).map((r) => r.chat_id);
  if (chatIds.length === 0) return;

  // Send alerts
  for (const km of fresh) {
    const text = formatKillAlert(km);
    for (const chatId of chatIds) {
      try {
        pollSender!(chatId, text);
      } catch (err) {
        console.error(`${LOG} send failed chat=${chatId}:`, (err as Error).message);
      }
    }
  }

  console.log(`${LOG} ${topic}: ${fresh.length} new kills → ${chatIds.length} chats`);
}

// ---------------------------------------------------------------------------
// Topic → killlist params mapping
// ---------------------------------------------------------------------------

function topicToKilllistParams(topic: string): Record<string, string | number> | null {
  const [type, idStr] = topic.split('.');
  const id = Number(idStr);
  if (!type || !Number.isFinite(id)) return null;

  switch (type) {
    case 'system':    return { system_id: id };
    case 'region':    return { region_id: id };
    case 'victim':    return { character_id: id };  // killlist returns losses for character
    case 'attacker':  return { character_id: id };  // killlist returns kills+losses
    default:          return null;
  }
}

// ---------------------------------------------------------------------------
// Alert formatting
// ---------------------------------------------------------------------------

function formatKillAlert(km: KilllistItem): string {
  const victim = km.victim_character_name ?? km.victim_corporation_name ?? '?';
  const ship = km.ship_name ?? '?';
  const system = km.solar_system_name ?? '?';
  const sec = km.solar_system_security != null ? ` (${km.solar_system_security.toFixed(1)})` : '';
  const value = km.total_value ? `${Math.round(km.total_value / 1_000_000)}M ISK` : '?';
  const attacker = km.final_blow_character_name ?? km.final_blow_corporation_name ?? '?';
  const npcTag = km.is_npc ? ' [NPC]' : '';
  const soloTag = km.is_solo ? ' [SOLO]' : '';
  const url = `https://eve-kill.com/kill/${km.killmail_id}`;

  return `🔴 ${victim} lost ${ship} in ${system}${sec}${npcTag}${soloTag}\n💰 ${value} | Killer: ${attacker}\n${url}`;
}

// ---------------------------------------------------------------------------
// DB persistence for last_seen
// ---------------------------------------------------------------------------

function ensureLastSeenTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kill_watch_state (
      topic TEXT PRIMARY KEY,
      last_killmail_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function saveLastSeen(db: Db, topic: string, killmailId: number): void {
  db.prepare(`
    INSERT INTO kill_watch_state (topic, last_killmail_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(topic) DO UPDATE SET
      last_killmail_id = excluded.last_killmail_id,
      updated_at = excluded.updated_at
  `).run(topic, killmailId);
}
