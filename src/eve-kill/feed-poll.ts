import type { Db } from '../db/sqlite.js';
import { fetchFeedPage, eveKillKillmailUrl } from './client.js';
import type { ApiResult, FeedEvent, FeedWatchMatch } from './types.js';
import { isPermanentOutboundFailure } from '../messaging/outbound.js';

const FEED_KEY = 'global';
const DEFAULT_LIMIT = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

export type FeedNotificationSender = (chatId: number, text: string) => Promise<void>;
export type FeedEventListener = (event: FeedEvent) => void | Promise<void>;

export type FeedPollOptions = {
  limit?: number;
  pollIntervalMs?: number;
  backoffMaxMs?: number;
  /** Suspends watches for chat platforms that are not active in this process. */
  canDeliver?: (chatId: number) => boolean;
  /** Runs exactly once after a cursor exists and before any resumed event is processed. */
  onReady?: () => void | Promise<void>;
};

export type FeedPollOutcome = {
  bootstrapped: boolean;
  processed: number;
  delivered: number;
  cursor: number;
  hasMore: boolean;
};

type FeedStateRow = { last_sequence_id: number };
type WatchRow = { id: number; chat_id: number; topic: string; label: string };

const listeners = new Set<FeedEventListener>();
let running: { stopped: boolean; wake: AbortController; done: Promise<void> } | null = null;
let lastPollAt: string | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;

export function getEveKillFeedRuntimeStatus(): {
  running: boolean;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
} {
  return { running: Boolean(running), lastPollAt, lastSuccessAt, lastError };
}

/** Registers an in-process consumer before the baseline poll. */
export function subscribeEveKillFeed(listener: FeedEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Polls and processes one feed page. A missing cursor is bootstrapped to the
 * server head without replaying history. The cursor moves only after every
 * listener and matching chat has completed successfully.
 */
export async function runFeedPollOnce(
  db: Db,
  send: FeedNotificationSender,
  options: Pick<FeedPollOptions, 'limit' | 'canDeliver'> = {},
): Promise<ApiResult<FeedPollOutcome>> {
  const state = readFeedState(db);
  const limit = boundedLimit(options.limit);

  if (!state) {
    const bootstrap = await fetchFeedPage(0, limit);
    if (!bootstrap.ok) return bootstrap;
    writeFeedState(db, bootstrap.data.latest);
    pruneNotificationDedupIfDue(db);
    return {
      ok: true,
      data: {
        bootstrapped: true,
        processed: 0,
        delivered: 0,
        cursor: bootstrap.data.latest,
        hasMore: false,
      },
    };
  }

  pruneNotificationDedupIfDue(db);
  const page = await fetchFeedPage(state.last_sequence_id, limit);
  if (!page.ok) return page;
  const events = page.data.events.filter((event) => event.sequenceId > state.last_sequence_id);
  if (page.data.hasMore && events.length === 0) {
    return { ok: false, error: 'EVE-KILL feed returned hasMore without a newer event' };
  }
  let cursor = state.last_sequence_id;
  let delivered = 0;

  for (const event of events) {
    try {
      for (const listener of listeners) {
        try {
          await listener(event);
        } catch (error) {
          if (!isPermanentOutboundFailure(error)) throw error;
          console.warn(
            `[eve-kill-feed] terminal listener delivery failure at sequence ${event.sequenceId}; event acknowledged`,
          );
        }
      }

      const matches = matchFeedEventToWatches(db, event);
      const byChat = groupMatchesByChat(matches);
      for (const [chatId, chatMatches] of byChat) {
        // Watches from a platform disabled in this self-hosted process are
        // suspended. They must not poison the one global cursor for active
        // platforms; events missed while disabled are intentionally not replayed.
        if (options.canDeliver && !options.canDeliver(chatId)) continue;
        if (wasDelivered(db, chatId, event.killmail.killmailId)) continue;
        try {
          await send(chatId, formatFeedNotification(event, chatMatches));
        } catch (error) {
          if (!isPermanentOutboundFailure(error)) throw error;
          // A terminal platform rejection is an acknowledgement for this
          // recipient. Persist it so retries resume only transient failures and
          // the shared cursor cannot be held by one unreachable chat.
          recordDelivery(db, chatId, event);
          console.warn(
            `[eve-kill-feed] terminal watch delivery failure chat=${chatId} sequence=${event.sequenceId}; recipient acknowledged`,
          );
          continue;
        }
        recordDelivery(db, chatId, event);
        delivered += 1;
      }
      writeFeedState(db, event.sequenceId);
      cursor = event.sequenceId;
    } catch {
      return {
        ok: false,
        error: `EVE-KILL feed processing failed at sequence ${event.sequenceId}`,
      };
    }
  }

  return {
    ok: true,
    data: {
      bootstrapped: false,
      processed: events.length,
      delivered,
      cursor,
      hasMore: page.data.hasMore,
    },
  };
}

export function startEveKillFeedPoller(
  db: Db,
  send: FeedNotificationSender,
  options: FeedPollOptions = {},
): void {
  if (running) return;
  const current = { stopped: false, wake: new AbortController(), done: Promise.resolve() };
  running = current;
  current.done = feedLoop(db, send, options, current)
    .finally(() => { if (running === current) running = null; });
  void current.done.catch(() => {
    console.error('[eve-kill-feed] poller stopped unexpectedly');
  });
}

export async function stopEveKillFeedPoller(): Promise<void> {
  const current = running;
  if (!current) return;
  current.stopped = true;
  current.wake.abort();
  await current.done;
}

export function matchFeedEventToWatches(db: Db, event: FeedEvent): FeedWatchMatch[] {
  const topics = eventTopics(db, event);
  if (topics.size === 0) return [];
  const rows = db.prepare('SELECT id, chat_id, topic, label FROM kill_watches ORDER BY id').all() as WatchRow[];
  return rows
    .filter((row) => topics.has(row.topic))
    .map((row) => ({ watchId: row.id, chatId: row.chat_id, topic: row.topic, label: row.label }));
}

export function formatFeedNotification(event: FeedEvent, matches: FeedWatchMatch[]): string {
  const kill = event.killmail;
  const labels = [...new Set(matches.map((match) => match.label || match.topic))].join(', ');
  const victim = kill.victim.characterName ?? kill.victim.corporationName ?? `entity ${kill.victim.characterId ?? kill.victim.corporationId ?? 'unknown'}`;
  const ship = kill.victim.shipName ?? (kill.victim.shipTypeId ? `ship type ${kill.victim.shipTypeId}` : 'unknown ship');
  const system = kill.solarSystemName ?? (kill.solarSystemId ? `system ${kill.solarSystemId}` : 'unknown system');
  return [
    `EVE-KILL watch: ${labels}`,
    `${victim} lost ${ship} in ${system}.`,
    eveKillKillmailUrl(kill.killmailId),
  ].join('\n');
}

async function feedLoop(
  db: Db,
  send: FeedNotificationSender,
  options: FeedPollOptions,
  state: { stopped: boolean; wake: AbortController },
): Promise<void> {
  const interval = boundedDelay(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 60_000);
  const backoffMax = boundedDelay(options.backoffMaxMs, DEFAULT_BACKOFF_MAX_MS, 300_000);
  let failures = 0;
  let ready = options.onReady === undefined;
  while (!state.stopped) {
    if (!ready && readFeedState(db)) {
      try {
        await options.onReady?.();
        ready = true;
        failures = 0;
      } catch {
        failures += 1;
        await interruptibleDelay(
          Math.min(backoffMax, interval * (2 ** Math.min(failures - 1, 8))),
          state.wake.signal,
        );
        continue;
      }
    }
    const result = await runFeedPollOnce(db, send, options);
    lastPollAt = new Date().toISOString();
    if (result.ok) {
      lastSuccessAt = lastPollAt;
      lastError = null;
    } else {
      lastError = result.error.slice(0, 200);
    }
    if (state.stopped) break;
    if (result.ok && !ready) {
      try {
        await options.onReady?.();
        ready = true;
      } catch {
        failures += 1;
        await interruptibleDelay(
          Math.min(backoffMax, interval * (2 ** Math.min(failures - 1, 8))),
          state.wake.signal,
        );
        continue;
      }
    }
    if (result.ok) failures = 0;
    else failures += 1;
    const delay = result.ok
      ? (result.data.hasMore ? 0 : interval)
      : Math.min(backoffMax, interval * (2 ** Math.min(failures - 1, 8)));
    await interruptibleDelay(delay, state.wake.signal);
  }
}

function readFeedState(db: Db): FeedStateRow | undefined {
  return db.prepare(
    'SELECT last_sequence_id FROM eve_kill_feed_state WHERE feed_key = ?',
  ).get(FEED_KEY) as FeedStateRow | undefined;
}

function writeFeedState(db: Db, sequenceId: number): void {
  db.prepare(`
    INSERT INTO eve_kill_feed_state (feed_key, last_sequence_id, initialized_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(feed_key) DO UPDATE SET
      last_sequence_id = excluded.last_sequence_id,
      updated_at = datetime('now')
  `).run(FEED_KEY, sequenceId);
}

function wasDelivered(db: Db, chatId: number, killmailId: number): boolean {
  return db.prepare(
    'SELECT 1 FROM eve_kill_notification_dedup WHERE chat_id = ? AND killmail_id = ?',
  ).get(chatId, killmailId) !== undefined;
}

function recordDelivery(db: Db, chatId: number, event: FeedEvent): void {
  db.prepare(`
    INSERT OR IGNORE INTO eve_kill_notification_dedup
      (chat_id, killmail_id, sequence_id, delivered_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(chatId, event.killmail.killmailId, event.sequenceId);
}

function pruneNotificationDedupIfDue(db: Db): void {
  const state = db.prepare(
    'SELECT dedup_pruned_at FROM eve_kill_feed_state WHERE feed_key = ?',
  ).get(FEED_KEY) as { dedup_pruned_at: string | null } | undefined;
  if (!state || (state.dedup_pruned_at && Date.parse(`${state.dedup_pruned_at}Z`) > Date.now() - 24 * 60 * 60 * 1000)) {
    return;
  }
  const prune = db.transaction(() => {
    db.prepare("DELETE FROM eve_kill_notification_dedup WHERE delivered_at < datetime('now', '-30 days')").run();
    db.prepare(
      "UPDATE eve_kill_feed_state SET dedup_pruned_at = datetime('now') WHERE feed_key = ?",
    ).run(FEED_KEY);
  });
  prune();
}

function eventTopics(db: Db, event: FeedEvent): Set<string> {
  const kill = event.killmail;
  const topics = new Set<string>();
  if (kill.solarSystemId) topics.add(`system.${kill.solarSystemId}`);
  // Region topology is static data and therefore belongs to the installed SDE.
  // A third-party region field is neither needed nor allowed to stall the
  // global cursor when it disagrees with the local snapshot.
  const regionId = regionForSystem(db, kill.solarSystemId);
  if (regionId) topics.add(`region.${regionId}`);
  for (const id of entityIds(kill.victim)) topics.add(`victim.${id}`);
  for (const attacker of kill.attackers) {
    for (const id of entityIds(attacker)) topics.add(`attacker.${id}`);
  }
  return topics;
}

function regionForSystem(db: Db, systemId: number | undefined): number | undefined {
  if (!systemId) return undefined;
  const row = db.prepare(`
    SELECT c.region_id
    FROM sde_systems AS s
    JOIN sde_constellations AS c ON c.constellation_id = s.constellation_id
    WHERE s.system_id = ?
  `).get(systemId) as { region_id: number | null } | undefined;
  return row?.region_id ?? undefined;
}

function entityIds(entity: FeedEvent['killmail']['victim']): number[] {
  return [entity.characterId, entity.corporationId, entity.allianceId, entity.factionId]
    .filter((id): id is number => id !== undefined);
}

function groupMatchesByChat(matches: FeedWatchMatch[]): Map<number, FeedWatchMatch[]> {
  const grouped = new Map<number, FeedWatchMatch[]>();
  for (const match of matches) {
    const current = grouped.get(match.chatId) ?? [];
    current.push(match);
    grouped.set(match.chatId, current);
  }
  return grouped;
}

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(1_000, Math.trunc(value ?? DEFAULT_LIMIT)));
}

function boundedDelay(value: number | undefined, fallback: number, max: number): number {
  return Math.max(0, Math.min(max, Math.trunc(value ?? fallback)));
}

async function interruptibleDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
