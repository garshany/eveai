import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import {
  claimTelegramUpdate,
  pruneProcessedUpdates,
  resetDedupCounterForTests,
  __test__,
} from '../../src/telegram/update-dedup.js';

let db: Database.Database;

function rowCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM telegram_processed_updates').get() as { n: number }).n;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetDedupCounterForTests();
});

afterEach(() => {
  db.close();
});

describe('claimTelegramUpdate', () => {
  it('claims an update once and rejects the redelivery', () => {
    expect(claimTelegramUpdate(db, 1001)).toBe(true);
    // Same update_id redelivered after a restart: the offset was never confirmed.
    expect(claimTelegramUpdate(db, 1001)).toBe(false);
    expect(claimTelegramUpdate(db, 1002)).toBe(true);
  });

  it('survives a restart — the claim lives in the database, not in memory', () => {
    claimTelegramUpdate(db, 2001);
    resetDedupCounterForTests(); // simulate a fresh process against the same file
    expect(claimTelegramUpdate(db, 2001)).toBe(false);
  });

  it('prunes on cadence so the table stays bounded', () => {
    const old = `-${__test__.RETENTION_DAYS + 1} days`;
    for (let i = 0; i < 10; i += 1) {
      db.prepare(
        `INSERT INTO telegram_processed_updates (update_id, processed_at) VALUES (?, datetime('now', ?))`,
      ).run(i, old);
    }
    expect(rowCount()).toBe(10);

    for (let i = 0; i < __test__.PRUNE_EVERY_CLAIMS; i += 1) {
      claimTelegramUpdate(db, 100_000 + i);
    }

    // The stale decade is gone; only the fresh claims remain.
    expect(rowCount()).toBe(__test__.PRUNE_EVERY_CLAIMS);
  });
});

describe('pruneProcessedUpdates', () => {
  it('keeps rows inside the retention window', () => {
    db.prepare(
      `INSERT INTO telegram_processed_updates (update_id, processed_at) VALUES (1, datetime('now', ?))`,
    ).run(`-${__test__.RETENTION_DAYS - 1} days`);
    db.prepare(
      `INSERT INTO telegram_processed_updates (update_id, processed_at) VALUES (2, datetime('now', ?))`,
    ).run(`-${__test__.RETENTION_DAYS + 1} days`);

    expect(pruneProcessedUpdates(db)).toBe(1);
    expect(rowCount()).toBe(1);
  });
});
