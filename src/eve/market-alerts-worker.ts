/**
 * Market price alerts worker -- evaluates active one-shot alerts against the
 * local market_orders snapshot and records firings in market_alert_events.
 *
 * Tick (every 5 minutes, same cadence as the snapshot sweep's major regions
 * so the book it reads is at most one sweep old): one SELECT joins every
 * active alert with its current best price (sell -> MIN(price) over sell
 * orders, buy -> MAX(price) over buy orders, both via the
 * (type_id, region_id, is_buy_order, price) index; NULL when the book has no
 * orders for the pair, which never fires). An alert fires when its comparator
 * crosses the threshold: 'above' -> best >= threshold, 'below' -> best <=
 * threshold.
 *
 * Alerts are one-shot: the claim is an atomic UPDATE ... WHERE status =
 * 'active', so a tick overlap, a restart, or a concurrent user delete can at
 * most make the claim a no-op — an alert can never fire twice and there is
 * no cooldown state. The claim and the market_alert_events insert commit in a
 * single transaction for the whole batch; push delivery happens after the
 * commit so a slow platform send never holds the write transaction, and the
 * event row stays visible in the UI even when delivery fails (delivered_at
 * flips only after the sender resolves). Each send is bounded by a deadline
 * (DEFAULT_SEND_TIMEOUT_MS) so a hung platform write cannot park the
 * single-flight tick. A failed send is recorded on the event (see
 * redeliverUndeliveredEvents for the retry/backoff/give-up policy).
 *
 * Single-flight: one tick at a time — croner's `protect: true` already
 * serializes the schedule, and runMarketAlertsTick applies the same guard to
 * direct callers (tests). A tick that finds one in flight returns immediately
 * instead of queueing: the next tick is five minutes away anyway. Same
 * contract as market-history-worker.ts.
 *
 * Shutdown: stop() kills the schedule, then waits for the in-flight tick.
 * Every firing commits independently inside the batch transaction, so a
 * mid-tick exit loses at most undelivered pushes (delivered_at stays NULL) —
 * never an event row.
 */

import { Cron } from 'croner';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { getUserOutboundChatId, getUserTelegramChatId } from '../auth/user-resolver.js';
import { deliverOutbound } from '../messaging/outbound.js';

// Same */5 cadence the snapshot sweep uses for major regions; the evaluation
// is a handful of indexed reads, so there is nothing to gain from a slower
// schedule, and a faster one would just re-read the same cached book.
const MARKET_ALERTS_CRON = '*/5 * * * *';

// One platform send must never park the single-flight tick: a hung
// Telegram/Discord write would otherwise hold tickInFlight forever and
// silently stop all alert evaluation until a restart. 30s is far above a
// healthy send (a few seconds at worst), and a stalled send just leaves
// delivered_at NULL while the tick moves on.
const DEFAULT_SEND_TIMEOUT_MS = 30_000;

// Pushes run with small concurrency and stop starting new sends once the
// phase budget is spent, so a batch of slow/hung lanes (each up to
// DEFAULT_SEND_TIMEOUT_MS) cannot stretch one tick to many minutes. Unsent
// events simply stay pending for the next tick.
const DEFAULT_DELIVERY_CONCURRENCY = 4;
const DEFAULT_DELIVERY_BUDGET_MS = 60_000;

let cronJob: Cron | null = null;
// The single-flight guard for every tick entry point; see the module header.
let tickInFlight: Promise<void> | null = null;

/**
 * Push channel for a fired alert. Rejects when the push did not land; rejects
 * with NoOutboundLaneError when the user has no outbound lane at all, which
 * makes the event terminal (never retried).
 */
export type MarketAlertNotificationSender = (userId: number, text: string) => Promise<void>;

/** The user has no Telegram or Discord lane at all: retrying cannot help. */
export class NoOutboundLaneError extends Error {
  constructor(userId: number) {
    super(`no outbound lane for user ${userId}`);
    this.name = 'NoOutboundLaneError';
  }
}

export type MarketAlertsTickDeps = {
  sendNotification?: MarketAlertNotificationSender;
  // Per-send deadline; defaults to DEFAULT_SEND_TIMEOUT_MS. Tests shrink it.
  sendTimeoutMs?: number;
  // Parallel sends per delivery phase; defaults to DEFAULT_DELIVERY_CONCURRENCY.
  deliveryConcurrency?: number;
  // No new send starts after this much time in a delivery phase; defaults to
  // DEFAULT_DELIVERY_BUDGET_MS.
  deliveryBudgetMs?: number;
};

type ActiveAlertRow = {
  alert_id: number;
  user_id: number;
  type_id: number;
  region_id: number;
  side: 'sell' | 'buy';
  comparator: 'above' | 'below';
  threshold_price: number;
  best_price: number | null;
};

type FiringAlertRow = ActiveAlertRow & { best_price: number };

export function startMarketAlertsWorker(db: Db): void {
  if (!config.marketAlerts.enabled) {
    console.log('[market-alerts] Worker disabled (MARKET_ALERTS_ENABLED=false)');
    return;
  }
  console.log('[market-alerts] Starting market alerts worker');

  cronJob = new Cron(MARKET_ALERTS_CRON, { protect: true }, async () => {
    try {
      await runMarketAlertsTick(db);
    } catch (err) {
      // Per-event failures are already logged at warn level; this guards
      // against anything unexpected at the tick level.
      console.error('[market-alerts] tick error:', err);
    }
  });
}

export async function stopMarketAlertsWorker(): Promise<void> {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  // Wait for the in-flight tick to finish (bounded by the caller's shutdown
  // deadline) instead of abandoning pushes mid-send.
  await tickInFlight?.catch(() => {});
  console.log('[market-alerts] Stopped');
}

export async function runMarketAlertsTick(
  db: Db,
  deps: MarketAlertsTickDeps = {},
): Promise<void> {
  if (tickInFlight) {
    // A tick is already running: skip rather than queue — the next cron tick
    // is five minutes away regardless.
    console.log('[market-alerts] Tick already in flight; skipping this tick');
    return;
  }
  const tick = tickOnce(db, deps);
  tickInFlight = tick;
  try {
    await tick;
  } finally {
    if (tickInFlight === tick) tickInFlight = null;
  }
}

async function tickOnce(db: Db, deps: MarketAlertsTickDeps): Promise<void> {
  await redeliverUndeliveredEvents(db, deps);
  const rows = db.prepare(`
    SELECT a.alert_id, a.user_id, a.type_id, a.region_id, a.side, a.comparator, a.threshold_price,
      CASE a.side
        WHEN 'sell' THEN (
          SELECT MIN(o.price) FROM market_orders o
          WHERE o.region_id = a.region_id AND o.type_id = a.type_id AND o.is_buy_order = 0
        )
        ELSE (
          SELECT MAX(o.price) FROM market_orders o
          WHERE o.region_id = a.region_id AND o.type_id = a.type_id AND o.is_buy_order = 1
        )
      END AS best_price
    FROM market_price_alerts a
    WHERE a.status = 'active'
  `).all() as ActiveAlertRow[];

  const firing = rows.filter((row): row is FiringAlertRow =>
    row.best_price !== null && (row.comparator === 'above'
      ? row.best_price >= row.threshold_price
      : row.best_price <= row.threshold_price));
  if (firing.length === 0) return;

  // One transaction for the whole batch: each firing is an atomic claim
  // (UPDATE ... WHERE status='active') plus its event row. A concurrent
  // delete/disable or a racing claimant makes changes=0 and the event is
  // skipped, which is exactly the one-shot guarantee.
  const claim = db.prepare(`
    UPDATE market_price_alerts
    SET status = 'triggered', triggered_at = datetime('now'), trigger_price = ?
    WHERE alert_id = ? AND status = 'active'
  `);
  const record = db.prepare(`
    INSERT INTO market_alert_events (alert_id, user_id, type_id, price, threshold)
    VALUES (?, ?, ?, ?, ?)
  `);
  const fired: Array<{ eventId: number; row: FiringAlertRow }> = [];
  db.transaction(() => {
    for (const row of firing) {
      if (claim.run(row.best_price, row.alert_id).changes === 0) continue;
      const result = record.run(row.alert_id, row.user_id, row.type_id, row.best_price, row.threshold_price);
      fired.push({ eventId: Number(result.lastInsertRowid), row });
    }
  })();

  // A missing lane, a platform error, or a send timeout only leaves
  // delivered_at NULL (the UI still shows the firing); the failure is
  // recorded so redelivery applies its backoff/give-up policy.
  const { delivered } = await deliverEvents(
    db,
    deps,
    fired.map(({ eventId, row }) => ({ ...row, event_id: eventId })),
    'delivery',
  );
  console.log(
    '[market-alerts] Tick: %d fired, %d delivered (%d active scanned)',
    fired.length,
    delivered,
    rows.length,
  );
}

/**
 * Bound one platform send: the single-flight tick awaits delivery, so a send
 * that never settles would park every later tick (tickInFlight never clears)
 * until a restart. The deadline rejects like any platform error — the event
 * keeps delivered_at NULL and the tick moves on. Promise.race stays
 * subscribed to the losing send, so a late rejection never goes unhandled.
 */
async function withSendTimeout(send: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`market alert send timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([send, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Default push channel: the user's preferred outbound chat (Telegram when
 * linked, otherwise the most recent Discord DM), same resolution heartbeat
 * uses. Throws when the user has no live lane so the caller leaves
 * delivered_at NULL instead of pretending the push landed.
 */
async function defaultSendNotification(db: Db, userId: number, text: string): Promise<void> {
  const chatId = getUserOutboundChatId(db, userId);
  if (!chatId) {
    // No lane at all (never linked Telegram, no Discord DM) is terminal; a
    // linked lane whose platform sender is offline right now is retryable.
    if (!userHasAnyOutboundLane(db, userId)) throw new NoOutboundLaneError(userId);
    throw new Error(`no live outbound lane for user ${userId}`);
  }
  await deliverOutbound(chatId, text);
}

function userHasAnyOutboundLane(db: Db, userId: number): boolean {
  if (getUserTelegramChatId(db, userId) !== null) return true;
  return db.prepare('SELECT 1 FROM discord_sessions WHERE user_id = ? LIMIT 1').get(userId) !== undefined;
}

/**
 * Durable delivery: an event whose platform send failed (timeout, dead lane,
 * process stop right after the claim transaction) keeps delivered_at NULL.
 * The alert itself is already 'triggered', so the main scan never revisits
 * it — this pass does. Marking delivered_at only after a successful send
 * keeps the exactly-once-per-event property (the event row IS the dedup key).
 *
 * Retry policy, so permanently failing events never starve the rest:
 *  - a user with no outbound lane at all (NoOutboundLaneError) makes the
 *    event terminal at once (abandoned_at), without further attempts;
 *  - every other failure bumps delivery_attempts and pushes next_attempt_at
 *    out exponentially (4, 8, 16 ... minutes, capped at 3h); only events whose
 *    next_attempt_at has passed are picked, fewest attempts first, so a
 *    backing-off event never occupies a batch slot;
 *  - after REDELIVERY_MAX_ATTEMPTS failures the event is abandoned;
 *  - events older than the 24h window are no longer retried;
 *  - the batch is bounded (REDELIVERY_BATCH) and sent with small concurrency
 *    under a time budget (see deliverEvents).
 */
const REDELIVERY_BATCH = 20;
const REDELIVERY_WINDOW_HOURS = 24;
const REDELIVERY_MAX_ATTEMPTS = 8;
// First retry lands on the next 5-minute tick.
const REDELIVERY_BACKOFF_BASE_MINUTES = 4;
const REDELIVERY_BACKOFF_MAX_MINUTES = 180;

type PendingEvent = FiringAlertRow & { event_id: number };

async function redeliverUndeliveredEvents(db: Db, deps: MarketAlertsTickDeps): Promise<void> {
  const pending = db.prepare(`
    SELECT e.event_id, e.alert_id, e.user_id, e.type_id, e.price AS best_price,
           e.threshold AS threshold_price, a.region_id, a.side, a.comparator
    FROM market_alert_events e
    JOIN market_price_alerts a ON a.alert_id = e.alert_id
    WHERE e.delivered_at IS NULL
      AND e.abandoned_at IS NULL
      AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= datetime('now'))
      AND e.triggered_at > datetime('now', '-' || ? || ' hours')
    ORDER BY e.delivery_attempts, e.triggered_at, e.event_id
    LIMIT ?
  `).all(REDELIVERY_WINDOW_HOURS, REDELIVERY_BATCH) as PendingEvent[];
  if (pending.length === 0) return;

  const { delivered, attempted } = await deliverEvents(db, deps, pending, 'redelivery');
  if (delivered > 0 || attempted < pending.length) {
    console.log(
      '[market-alerts] Redelivered %d/%d pending event(s) (%d attempted)',
      delivered,
      pending.length,
      attempted,
    );
  }
}

/**
 * Send each event's push with bounded concurrency; stop starting new sends
 * once the budget is spent (in-flight sends still finish, each bounded by
 * the send timeout). Success flips delivered_at; failure is recorded via
 * recordDeliveryFailure. Events never attempted are left untouched.
 */
async function deliverEvents(
  db: Db,
  deps: MarketAlertsTickDeps,
  events: readonly PendingEvent[],
  phase: 'delivery' | 'redelivery',
): Promise<{ delivered: number; attempted: number }> {
  if (events.length === 0) return { delivered: 0, attempted: 0 };
  const sendNotification = deps.sendNotification
    ?? ((userId: number, text: string) => defaultSendNotification(db, userId, text));
  const sendTimeoutMs = deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const concurrency = Math.max(1, deps.deliveryConcurrency ?? DEFAULT_DELIVERY_CONCURRENCY);
  const deadline = Date.now() + (deps.deliveryBudgetMs ?? DEFAULT_DELIVERY_BUDGET_MS);
  const markDelivered = db.prepare(
    "UPDATE market_alert_events SET delivered_at = datetime('now'), next_attempt_at = NULL WHERE event_id = ? AND delivered_at IS NULL",
  );

  let delivered = 0;
  let attempted = 0;
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < events.length && Date.now() < deadline) {
      const event = events[nextIndex];
      nextIndex += 1;
      attempted += 1;
      try {
        await withSendTimeout(sendNotification(event.user_id, formatAlertMessage(db, event)), sendTimeoutMs);
        markDelivered.run(event.event_id);
        delivered += 1;
      } catch (err) {
        const outcome = recordDeliveryFailure(db, event.event_id, err);
        console.warn(
          '[market-alerts] %s failed for event=%d user=%d (%s): %s',
          phase,
          event.event_id,
          event.user_id,
          outcome,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, events.length) }, worker));
  return { delivered, attempted };
}

/**
 * Record one failed send: terminal for a user without any lane or once the
 * attempt cap is reached, otherwise schedule the next attempt with
 * exponential backoff. Returns a short label for the log line.
 */
function recordDeliveryFailure(db: Db, eventId: number, err: unknown): string {
  const row = db.prepare(
    'SELECT delivery_attempts FROM market_alert_events WHERE event_id = ?',
  ).get(eventId) as { delivery_attempts: number } | undefined;
  if (!row) return 'gone';
  const attempts = row.delivery_attempts + 1;
  if (err instanceof NoOutboundLaneError || attempts >= REDELIVERY_MAX_ATTEMPTS) {
    db.prepare(`
      UPDATE market_alert_events
      SET delivery_attempts = ?, next_attempt_at = NULL, abandoned_at = datetime('now')
      WHERE event_id = ? AND delivered_at IS NULL
    `).run(attempts, eventId);
    return err instanceof NoOutboundLaneError ? 'no lane, abandoned' : `attempt ${attempts}, abandoned`;
  }
  const delayMinutes = Math.min(
    REDELIVERY_BACKOFF_BASE_MINUTES * 2 ** (attempts - 1),
    REDELIVERY_BACKOFF_MAX_MINUTES,
  );
  db.prepare(`
    UPDATE market_alert_events
    SET delivery_attempts = ?, next_attempt_at = datetime('now', '+' || ? || ' minutes')
    WHERE event_id = ? AND delivered_at IS NULL
  `).run(attempts, delayMinutes, eventId);
  return `attempt ${attempts}, retry in ${delayMinutes}m`;
}

function formatAlertMessage(db: Db, row: FiringAlertRow): string {
  const typeName = sdeName(db, 'SELECT name FROM sde_types WHERE type_id = ?', row.type_id, `type:${row.type_id}`);
  const regionName = sdeName(db, 'SELECT name FROM sde_regions WHERE region_id = ?', row.region_id, `region:${row.region_id}`);
  return `🔔 ${typeName}: ${row.side} ${row.comparator} ${formatIsk(row.threshold_price)} — сейчас ${formatIsk(row.best_price)} (${regionName})`;
}

function sdeName(db: Db, sql: string, id: number, fallback: string): string {
  const row = db.prepare(sql).get(id) as { name: string } | undefined;
  return row?.name ?? fallback;
}

function formatIsk(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} ISK`;
}
