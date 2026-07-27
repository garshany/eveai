import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { recordUsageEvent } from '../../src/usage/tracker.js';
import { DAY_MS, rollupUsageEvents } from '../../src/usage/rollup.js';
import { buildUsageReport } from '../../src/usage/stats.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

// Fixed reference point: 2026-07-27 12:00 UTC. "Today" = 2026-07-27 UTC.
const NOW_MS = Date.UTC(2026, 6, 27, 12, 0, 0);

function addEvent(overrides: {
  createdAtMs: number;
  userId?: number;
  model?: string;
  input?: number;
  output?: number;
  costMicros?: number | null;
}): void {
  recordUsageEvent(db, {
    createdAtMs: overrides.createdAtMs,
    userId: overrides.userId ?? 1,
    threadId: 'thread-1',
    channel: 'web',
    model: overrides.model ?? 'model-a',
    usage: {
      input: overrides.input ?? 0,
      output: overrides.output ?? 0,
      cached: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    costMicros: overrides.costMicros ?? null,
  });
}

describe('buildUsageReport with freshly written events', () => {
  it('shows the very first event immediately, before any rollup ran', () => {
    addEvent({ createdAtMs: NOW_MS - 60_000, userId: 7, input: 1200, output: 300, costMicros: 500 });

    const report = buildUsageReport(db, { nowMs: NOW_MS });

    expect(report.totals.events).toBe(1);
    expect(report.totals.inputTokens).toBe(1200);
    expect(report.totals.outputTokens).toBe(300);
    expect(report.totals.totalTokens).toBe(1500);
    expect(report.totals.costMicros).toBe(500);
    expect(report.totals.since).toBe('2026-07-27');
    expect(report.daily.at(-1)).toMatchObject({ day: '2026-07-27', events: 1, inputTokens: 1200 });
    expect(report.monthly).toEqual([expect.objectContaining({ month: '2026-07', events: 1 })]);
    expect(report.models).toEqual([expect.objectContaining({ model: 'model-a', events: 1, inputTokens: 1200 })]);
  });

  it('keeps since and totals intact across empty days', () => {
    addEvent({ createdAtMs: NOW_MS - 5 * DAY_MS, input: 100, output: 10, costMicros: 50 });
    addEvent({ createdAtMs: NOW_MS - 60_000, input: 200, output: 20, costMicros: 100 });
    rollupUsageEvents(db, NOW_MS);

    const report = buildUsageReport(db, { nowMs: NOW_MS });

    expect(report.totals.events).toBe(2);
    expect(report.totals.inputTokens).toBe(300);
    expect(report.totals.since).toBe('2026-07-22');
    expect(report.daily).toHaveLength(30);
    expect(report.daily.filter((row) => row.events === 0)).toHaveLength(28);
    // The single non-empty historical bucket sits on its own day.
    expect(report.daily.find((row) => row.day === '2026-07-22')).toMatchObject({ events: 1, inputTokens: 100 });
  });

  it('the first scheduled rollup picks up events recorded before it ever ran', () => {
    // Events written days earlier (e.g. straight after the accounting deploy),
    // while the rollup has never run yet: they must not be dropped.
    addEvent({ createdAtMs: NOW_MS - 10 * DAY_MS, input: 100, output: 10, costMicros: 50 });
    addEvent({ createdAtMs: NOW_MS - 3 * DAY_MS, input: 200, output: 20, costMicros: 100 });

    const result = rollupUsageEvents(db, NOW_MS);
    expect(result.rolledEvents).toBe(2);

    const report = buildUsageReport(db, { nowMs: NOW_MS });
    expect(report.totals.events).toBe(2);
    expect(report.totals.inputTokens).toBe(300);
    expect(report.totals.costMicros).toBe(150);
    expect(report.totals.since).toBe('2026-07-17');
  });

  it('a personal cut sees that user’s first event right away, without a rollup', () => {
    addEvent({ createdAtMs: NOW_MS - 60_000, userId: 7, input: 100, output: 10, costMicros: 50 });
    addEvent({ createdAtMs: NOW_MS - 30_000, userId: 8, input: 900, output: 90, costMicros: 400 });

    const mine = buildUsageReport(db, { nowMs: NOW_MS, userId: 7 });

    expect(mine.totals.events).toBe(1);
    expect(mine.totals.inputTokens).toBe(100);
    expect(mine.totals.costMicros).toBe(50);
    expect(mine.totals.since).toBe('2026-07-27');
    expect(mine.models).toHaveLength(1);
  });
});
