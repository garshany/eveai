import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { recordUsageEvent } from '../../src/usage/tracker.js';
import { DAY_MS, rollupUsageEvents, startOfUtcDayMs } from '../../src/usage/rollup.js';
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
const TODAY_START = startOfUtcDayMs(NOW_MS);

function addEvent(overrides: {
  createdAtMs: number;
  userId?: number;
  channel?: 'web' | 'telegram' | 'discord' | 'cli';
  model?: string;
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  costMicros?: number | null;
}): void {
  recordUsageEvent(db, {
    createdAtMs: overrides.createdAtMs,
    userId: overrides.userId ?? 1,
    threadId: 'thread-1',
    channel: overrides.channel ?? 'web',
    model: overrides.model ?? 'model-a',
    usage: {
      input: overrides.input ?? 0,
      output: overrides.output ?? 0,
      cached: overrides.cached ?? 0,
      cacheWrite: overrides.cacheWrite ?? 0,
      reasoning: overrides.reasoning ?? 0,
    },
    costMicros: overrides.costMicros ?? null,
  });
}

describe('rollupUsageEvents', () => {
  it('folds past days into daily aggregates and keeps today raw', () => {
    addEvent({ createdAtMs: TODAY_START - DAY_MS + 3_600_000, userId: 1, input: 1000, output: 500, cached: 100, costMicros: 1500 });
    addEvent({ createdAtMs: TODAY_START - DAY_MS + 7_200_000, userId: 2, channel: 'telegram', input: 2000, output: 1000, costMicros: null });
    addEvent({ createdAtMs: TODAY_START - 2 * DAY_MS, userId: 1, channel: 'cli', model: 'model-b', input: 500, output: 100, costMicros: 500 });
    addEvent({ createdAtMs: TODAY_START + 1_800_000, userId: 1, input: 100, output: 50, costMicros: 100 });

    const result = rollupUsageEvents(db, NOW_MS, 30);

    expect(result.rolledDays).toBe(2);
    expect(result.rolledEvents).toBe(3);
    expect(result.prunedEvents).toBe(0);

    const daily = db.prepare('SELECT * FROM usage_daily ORDER BY day, user_id').all() as Array<Record<string, unknown>>;
    expect(daily).toHaveLength(3);

    const yesterdayUser1 = daily.find((row) => row.day === '2026-07-26' && row.user_id === 1)!;
    expect(yesterdayUser1).toMatchObject({
      channel: 'web', model: 'model-a', events: 1,
      input_tokens: 1000, output_tokens: 500, cached_tokens: 100,
      cost_micros: 1500, unknown_cost_events: 0,
    });

    const yesterdayUser2 = daily.find((row) => row.day === '2026-07-26' && row.user_id === 2)!;
    expect(yesterdayUser2).toMatchObject({
      channel: 'telegram', events: 1,
      input_tokens: 2000, cost_micros: 0, unknown_cost_events: 1,
    });

    const older = daily.find((row) => row.day === '2026-07-25')!;
    expect(older).toMatchObject({ channel: 'cli', model: 'model-b', cost_micros: 500 });

    // Raw rows stay for the retention window; today's tail is untouched.
    const rawCount = db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number };
    expect(rawCount.n).toBe(4);
  });

  it('is idempotent and corrects a day when a late event arrives', () => {
    addEvent({ createdAtMs: TODAY_START - DAY_MS, userId: 1, input: 100, output: 10, costMicros: 10 });
    rollupUsageEvents(db, NOW_MS, 30);
    // A turn finished past midnight and recorded into yesterday afterwards.
    addEvent({ createdAtMs: TODAY_START - DAY_MS + 1000, userId: 1, input: 200, output: 20, costMicros: 20 });
    const second = rollupUsageEvents(db, NOW_MS, 30);

    expect(second.rolledEvents).toBe(2);
    const row = db.prepare('SELECT * FROM usage_daily WHERE day = ?').get('2026-07-26') as Record<string, unknown>;
    expect(row).toMatchObject({ events: 2, input_tokens: 300, output_tokens: 30, cost_micros: 30 });

    const third = rollupUsageEvents(db, NOW_MS, 30);
    expect(third.rolledEvents).toBe(2);
    const again = db.prepare('SELECT * FROM usage_daily WHERE day = ?').get('2026-07-26') as Record<string, unknown>;
    expect(again).toMatchObject({ events: 2, input_tokens: 300 });
  });

  it('prunes raw events past the retention window but keeps the summaries', () => {
    const oldMs = TODAY_START - 31 * DAY_MS;
    addEvent({ createdAtMs: oldMs, userId: 1, input: 900, output: 90, costMicros: 90 });
    addEvent({ createdAtMs: TODAY_START - DAY_MS, userId: 1, input: 100, output: 10, costMicros: 10 });

    const result = rollupUsageEvents(db, NOW_MS, 30);

    expect(result.prunedEvents).toBe(1);
    const rawOld = db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE created_at_ms < ?')
      .get(TODAY_START - 30 * DAY_MS) as { n: number };
    expect(rawOld.n).toBe(0);
    // The aggregate of the pruned day survives forever.
    const dailyOld = db.prepare('SELECT * FROM usage_daily WHERE day = ?')
      .get('2026-06-26') as Record<string, unknown>;
    expect(dailyOld).toMatchObject({ events: 1, input_tokens: 900, cost_micros: 90 });
  });
});

describe('buildUsageReport', () => {
  it('reads daily rows plus today\'s tail only — unrolled older raw rows stay invisible', () => {
    // Rolled history.
    addEvent({ createdAtMs: TODAY_START - DAY_MS, userId: 1, input: 1000, output: 500, costMicros: 100 });
    // Today's tail (never rolled).
    addEvent({ createdAtMs: TODAY_START + 3_600_000, userId: 1, input: 200, output: 100, costMicros: 20 });
    rollupUsageEvents(db, NOW_MS, 30);
    // A raw event from an hour ago that the rollup has not picked up yet — and
    // one planted in the far past without a rollup at all.
    addEvent({ createdAtMs: TODAY_START - 10 * DAY_MS, userId: 1, input: 999_999, output: 0, costMicros: 999_999 });

    const report = buildUsageReport(db, { nowMs: NOW_MS });

    // The far-past unrolled event must NOT leak into the public numbers:
    // the report reads summaries + today's tail, never the whole raw table.
    expect(report.totals.inputTokens).toBe(1200);
    expect(report.totals.outputTokens).toBe(600);
    expect(report.totals.costMicros).toBe(120);
    expect(report.totals.since).toBe('2026-07-26');

    const today = report.daily.at(-1)!;
    expect(today.day).toBe('2026-07-27');
    expect(today.inputTokens).toBe(200);
    const yesterday = report.daily.at(-2)!;
    expect(yesterday.inputTokens).toBe(1000);
    expect(report.daily).toHaveLength(30);
    // Zero-filled days carry explicit zeros.
    expect(report.daily[0]).toMatchObject({ events: 0, inputTokens: 0, costMicros: 0 });

    expect(report.monthly).toHaveLength(1);
    expect(report.monthly[0]).toMatchObject({ month: '2026-07', inputTokens: 1200, costMicros: 120 });
  });

  it('flags incomplete cost honestly when a tariff is unknown', () => {
    addEvent({ createdAtMs: TODAY_START + 1000, userId: 1, input: 100, output: 10, costMicros: null });

    const report = buildUsageReport(db, { nowMs: NOW_MS });

    expect(report.totals.costMicros).toBe(0); // no KNOWN cost yet — not "free"
    expect(report.totals.unknownCostEvents).toBe(1);
    expect(report.totals.costComplete).toBe(false);
  });

  it('filters every cut by user when userId is given', () => {
    addEvent({ createdAtMs: TODAY_START + 1000, userId: 1, input: 100, output: 10, model: 'model-a', costMicros: 10 });
    addEvent({ createdAtMs: TODAY_START + 2000, userId: 2, input: 9000, output: 900, model: 'model-b', costMicros: 900 });

    const own = buildUsageReport(db, { nowMs: NOW_MS, userId: 1 });

    expect(own.totals.inputTokens).toBe(100);
    expect(own.totals.costMicros).toBe(10);
    expect(own.models.map((entry) => entry.model)).toEqual(['model-a']);

    const everyone = buildUsageReport(db, { nowMs: NOW_MS });
    expect(everyone.totals.inputTokens).toBe(9100);
    expect(everyone.models.map((entry) => entry.model)).toEqual(['model-b', 'model-a']);
  });
});
