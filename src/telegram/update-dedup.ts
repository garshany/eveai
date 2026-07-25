/**
 * Persistent Telegram update de-duplication.
 *
 * Long polling confirms an offset only on the NEXT getUpdates call, so an
 * update whose handler already ran is redelivered when the process dies in
 * between. Since pending updates are deliberately kept across restarts
 * (TELEGRAM_DROP_PENDING_UPDATES=false), that replay would re-answer the
 * message and re-run its write tools — route monitors, intel notes, ESI
 * mutations — with the in-memory duplicate guard wiped by the restart.
 *
 * Each update is therefore claimed in SQLite before dispatch. The claim is the
 * insert itself, so it is atomic against a concurrent handler and survives the
 * restart. This makes handling at-most-once: an update whose process died
 * mid-turn is not retried, and the user resends. Messages that arrived while
 * the bot was DOWN were never claimed, so they still get answered — which is
 * the loss this whole path exists to prevent.
 */
import type { Db } from '../db/sqlite.js';

/** Prune cadence: often enough to stay bounded, rare enough to stay cheap. */
const PRUNE_EVERY_CLAIMS = 500;
/** Retention: far longer than Telegram's own ~24h redelivery window. */
const RETENTION_DAYS = 7;

let claimsSincePrune = 0;

/**
 * Record the update as handled. Returns false when it was already recorded,
 * meaning this is a redelivery and the caller must not process it again.
 */
export function claimTelegramUpdate(db: Db, updateId: number): boolean {
  const info = db.prepare(
    'INSERT OR IGNORE INTO telegram_processed_updates (update_id) VALUES (?)',
  ).run(updateId);

  claimsSincePrune += 1;
  if (claimsSincePrune >= PRUNE_EVERY_CLAIMS) {
    claimsSincePrune = 0;
    pruneProcessedUpdates(db);
  }

  return info.changes === 1;
}

/** Keep the table bounded; anything this old can no longer be redelivered. */
export function pruneProcessedUpdates(db: Db): number {
  const info = db.prepare(
    `DELETE FROM telegram_processed_updates WHERE processed_at < datetime('now', ?)`,
  ).run(`-${RETENTION_DAYS} days`);
  return info.changes;
}

export function resetDedupCounterForTests(): void {
  claimsSincePrune = 0;
}

export const __test__ = { PRUNE_EVERY_CLAIMS, RETENTION_DAYS };
