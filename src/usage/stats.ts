import type { Db } from '../db/sqlite.js';
import { DAY_MS, startOfUtcDayMs, utcDayString } from './rollup.js';

export type UsageSums = {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Sum of KNOWN costs only (integer microdollars). */
  costMicros: number;
  /** Events without a configured tariff; their cost is excluded above. */
  unknownCostEvents: number;
};

export type UsageTotals = UsageSums & {
  totalTokens: number;
  /** True only when every counted event had a tariff — costMicros is then exact. */
  costComplete: boolean;
  /** UTC day of the earliest accounted event, null when nothing was recorded. */
  since: string | null;
};

export type UsageReport = {
  totals: UsageTotals;
  /** Zero-filled trailing `days` window, oldest first, today last. */
  daily: Array<{ day: string } & UsageSums>;
  /** All-time monthly buckets, oldest first. */
  monthly: Array<{ month: string } & UsageSums>;
  /** All-time per-model buckets, biggest token spend first. */
  models: Array<{ model: string } & UsageSums>;
};

const EMPTY_SUMS: UsageSums = {
  events: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costMicros: 0,
  unknownCostEvents: 0,
};

function emptySums(): UsageSums {
  return { ...EMPTY_SUMS };
}

type SumRow = {
  events: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_micros: number;
  unknown_cost_events: number;
};

const SUM_SELECT = `
  COUNT(*) AS events,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(cost_micros), 0) AS cost_micros,
  COALESCE(SUM(cost_micros IS NULL), 0) AS unknown_cost_events
`;

// usage_daily stores pre-aggregated per-bucket rows, so every measure —
// including the event count itself — is a plain SUM over the stored columns.
const DAILY_SUM_SELECT = `
  COALESCE(SUM(events), 0) AS events,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(cost_micros), 0) AS cost_micros,
  COALESCE(SUM(unknown_cost_events), 0) AS unknown_cost_events
`;

function toSums(row: SumRow | undefined): UsageSums {
  if (!row) return emptySums();
  return {
    events: row.events,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    costMicros: row.cost_micros,
    unknownCostEvents: row.unknown_cost_events,
  };
}

function addInto(target: UsageSums, source: UsageSums): void {
  target.events += source.events;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cachedTokens += source.cachedTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.costMicros += source.costMicros;
  target.unknownCostEvents += source.unknownCostEvents;
}

/**
 * Public/personal spend report. Reads ONLY usage_daily plus today's raw tail
 * (created_at_ms >= UTC midnight): the raw table is never scanned whole.
 * With userId set the same cuts are produced for that single user — this is
 * the only per-user read path and it is reachable solely with that user's
 * own session.
 */
export function buildUsageReport(
  db: Db,
  options: { userId?: number; nowMs?: number; days?: number } = {},
): UsageReport {
  const nowMs = options.nowMs ?? Date.now();
  const windowDays = Math.max(1, Math.min(366, options.days ?? 30));
  const todayStart = startOfUtcDayMs(nowMs);
  const today = utcDayString(todayStart);
  const userFilter = options.userId === undefined ? '' : 'AND user_id = ?';
  const userArgs = options.userId === undefined ? [] : [options.userId];

  const dailyRows = db.prepare(`
    SELECT day, ${DAILY_SUM_SELECT}
    FROM usage_daily
    WHERE 1 = 1 ${userFilter}
    GROUP BY day
  `).all(...userArgs) as Array<{ day: string } & SumRow>;

  const tailTotals = toSums(db.prepare(`
    SELECT ${SUM_SELECT}
    FROM usage_events
    WHERE created_at_ms >= ? ${userFilter}
  `).get(todayStart, ...userArgs) as SumRow | undefined);

  const tailByModel = db.prepare(`
    SELECT model, ${SUM_SELECT}
    FROM usage_events
    WHERE created_at_ms >= ? ${userFilter}
    GROUP BY model
  `).all(todayStart, ...userArgs) as Array<{ model: string } & SumRow>;

  const modelRows = db.prepare(`
    SELECT model, ${DAILY_SUM_SELECT}
    FROM usage_daily
    WHERE 1 = 1 ${userFilter}
    GROUP BY model
  `).all(...userArgs) as Array<{ model: string } & SumRow>;

  // --- totals (all time) ---
  const totalsAcc = emptySums();
  let since: string | null = null;
  const byDay = new Map<string, UsageSums>();
  for (const row of dailyRows) {
    const sums = toSums(row);
    byDay.set(row.day, sums);
    addInto(totalsAcc, sums);
    if (since === null || row.day < since) since = row.day;
  }
  if (tailTotals.events > 0) {
    byDay.set(today, tailTotals);
    addInto(totalsAcc, tailTotals);
    if (since === null || today < since) since = today;
  }

  // --- daily: zero-filled trailing window ending today ---
  const daily: Array<{ day: string } & UsageSums> = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const day = utcDayString(todayStart - offset * DAY_MS);
    daily.push({ day, ...(byDay.get(day) ?? emptySums()) });
  }

  // --- monthly: all-time, tail merged into the current month ---
  const byMonth = new Map<string, UsageSums>();
  for (const [day, sums] of byDay) {
    const month = day.slice(0, 7);
    const acc = byMonth.get(month) ?? emptySums();
    addInto(acc, sums);
    byMonth.set(month, acc);
  }
  const monthly = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, sums]) => ({ month, ...sums }));

  // --- models: all-time, tail merged per model ---
  const byModel = new Map<string, UsageSums>();
  for (const row of modelRows) {
    byModel.set(row.model, toSums(row));
  }
  for (const row of tailByModel) {
    const acc = byModel.get(row.model) ?? emptySums();
    addInto(acc, toSums(row));
    byModel.set(row.model, acc);
  }
  const models = [...byModel.entries()]
    .map(([model, sums]) => ({ model, ...sums }))
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

  const totals: UsageTotals = {
    ...totalsAcc,
    totalTokens: totalsAcc.inputTokens + totalsAcc.outputTokens,
    costComplete: totalsAcc.unknownCostEvents === 0,
    since,
  };
  return { totals, daily, monthly, models };
}
