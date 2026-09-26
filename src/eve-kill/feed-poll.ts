import type { Db } from '../db/sqlite.js';
import { fetchFeedPage, eveKillKillmailUrl } from './client.js';
import type { ApiResult, FeedEvent, FeedWatchMatch } from './types.js';
import { isPermanentOutboundFailure } from '../messaging/outbound.js';

const FEED_KEY = 'global';
const DEFAULT_LIMIT = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
/**
 * Pages fetched ahead of a held cursor, per poll, for non-blocking observers.
 * Bounded so an outage on the watch path costs at most this many extra
 * requests per (backed-off) poll.
 */
const MAX_OBSERVE_AHEAD_PAGES = 10;

export type FeedNotificationSender = (chatId: number, text: string) => Promise<void>;
export type FeedEventListener = (event: FeedEvent) => void | Promise<void>;
/**
 * A non-blocking observer never holds the durable cursor: it is called before
 * the blocking listeners and watch delivery, is never awaited, and its
 * failures are logged and dropped. Delivery is at-least-once (a restart
 * replays from the durable cursor), so observers must be idempotent.
 */
export type FeedEventObserver = (event: FeedEvent) => void;
export type FeedSubscribeOptions = { mode?: 'blocking' | 'observer' };

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
const observers = new Set<FeedEventObserver>();
/**
 * Highest sequence already handed to observers. In memory only: after a
 * restart observers resume from the durable cursor, which is at-least-once.
 */
let observedThrough: number | null = null;
let lastObservedAt: string | null = null;
let running: { stopped: boolean; wake: AbortController; done: Promise<void> } | null = null;
let lastPollAt: string | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;

export function getEveKillFeedRuntimeStatus(): {
  running: boolean;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Last successful feed fetch whose events reached the non-blocking observers. */
  lastObservedAt: string | null;
} {
  return { running: Boolean(running), lastPollAt, lastSuccessAt, lastError, lastObservedAt };
}

/**
 * Registers an in-process consumer before the baseline poll. The default
 * `blocking` listener is awaited and a failure holds the durable cursor;
 * `observer` mode never blocks and keeps receiving new events while a blocking
 * consumer or a watch delivery is failing (see FeedEventObserver).
 */
export function subscribeEveKillFeed(
  listener: FeedEventListener,
  options: FeedSubscribeOptions = {},
): () => void {
  if (options.mode === 'observer') {
    const observer: FeedEventObserver = (event) => {
      const pending = listener(event);
      if (pending) {
        pending.catch((error: unknown) => {
          console.warn('[eve-kill-feed] observer failed: %s', (error as Error)?.message ?? String(error));
        });
      }
    };
    observers.add(observer);
    return () => { observers.delete(observer); };
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: forget the in-memory observer position. */
export function resetEveKillFeedObserversForTests(): void {
  observedThrough = null;
  lastObservedAt = null;
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
    observedThrough = bootstrap.data.latest;
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
  // Observers see the page before the blocking path, so a Telegram/Discord
  // outage that holds the cursor below cannot stall them.
  if (observedThrough === null || observedThrough < state.last_sequence_id
    || observedThrough > page.data.latest) {
    observedThrough = state.last_sequence_id;
  }
  notifyObservers(events);
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
      // The durable cursor is held for at-least-once watch delivery; keep the
      // observers moving past it so the live map does not freeze with it.
      if (page.data.hasMore) await observeAhead(limit);
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

function notifyObservers(events: FeedEvent[]): void {
  lastObservedAt = new Date().toISOString();
  for (const event of events) {
    if (observedThrough !== null && event.sequenceId <= observedThrough) continue;
    for (const observer of observers) {
      try {
        observer(event);
      } catch (error) {
        console.warn(
          '[eve-kill-feed] observer failed at sequence %d: %s',
          event.sequenceId,
          (error as Error).message,
        );
      }
    }
    observedThrough = event.sequenceId;
  }
}

/** Fetch pages beyond a held durable cursor for observers only. */
async function observeAhead(limit: number): Promise<void> {
  if (observers.size === 0) return;
  for (let pageIndex = 0; pageIndex < MAX_OBSERVE_AHEAD_PAGES; pageIndex += 1) {
    const after = observedThrough;
    if (after === null) return;
    const page = await fetchFeedPage(after, limit);
    if (!page.ok) return;
    const events = page.data.events.filter((event) => event.sequenceId > after);
    notifyObservers(events);
    if (!page.data.hasMore || events.length === 0) return;
  }
}

export function startEveKillFeedPoller(
  db: Db,
  send: FeedNotificationSender,
  options: FeedPollOptions = {},
): void {
  if (running) return;
  const current = { stopped: false, wake: new AbortController(), done: Promise.resolve() };
  running = current;
  observedThrough = null;
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
  // Exact-topic lookup via idx_kill_watches_topic; json_each keeps it a single
  // bound parameter no matter how many attacker topics the killmail carries.
  const rows = db.prepare(`
    SELECT id, chat_id, topic, label FROM kill_watches
    WHERE topic IN (SELECT value FROM json_each(?))
    ORDER BY id
  `).all(JSON.stringify([...topics])) as WatchRow[];
  return rows
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
    const onAbort = () => { clearTimeout(timer); resolve(); };
    // The wake signal lives for the whole poller; drop the listener when the
    // timer fires so every delay does not leave one behind.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
