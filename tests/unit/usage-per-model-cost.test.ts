import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { computeUsageCostMicros, type ModelPricingTable } from '../../src/usage/pricing.js';
import { recordUsageEvent } from '../../src/usage/tracker.js';
import { buildUsageReport } from '../../src/usage/stats.js';

/**
 * The support page's per-model breakdown prices every usage event by ITS OWN
 * model's tariff. Two events with identical token counts but different models
 * must land in separate per-model buckets with different costs.
 */
const PRICING: ModelPricingTable = {
  'gpt-5.6-sol': { input: 2, output: 8, cached: 0.5, reasoning: 8 },
  'gpt-5.6-terra': { input: 1, output: 4, cached: 0.25, reasoning: 4 },
  'gpt-5.6-luna': { input: 0.2, output: 0.8, cached: 0.05, reasoning: 0.8 },
};

const USAGE = { input: 10_000, output: 2_000, cached: 4_000, cacheWrite: 0, reasoning: 500 };

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

function recordModelTurn(model: string): number {
  const costMicros = computeUsageCostMicros(USAGE, PRICING, model);
  expect(costMicros).not.toBeNull();
  recordUsageEvent(db, {
    createdAtMs: Date.now(),
    userId: 1,
    threadId: 't1',
    channel: 'web',
    model,
    usage: USAGE,
    costMicros,
  });
  return costMicros!;
}

describe('per-model tariffs', () => {
  it('prices identical usage differently per model and keeps the buckets separate', () => {
    const solCost = recordModelTurn('gpt-5.6-sol');
    const terraCost = recordModelTurn('gpt-5.6-terra');
    const lunaCost = recordModelTurn('gpt-5.6-luna');

    // Same tokens, strictly tiered tariffs → strictly tiered costs.
    expect(solCost).toBeGreaterThan(terraCost);
    expect(terraCost).toBeGreaterThan(lunaCost);
    // Exact per-tariff math: (input-cached)*input + cached*cached
    // + (output-reasoning)*output + reasoning*reasoning, in microdollars.
    expect(solCost).toBe(6_000 * 2 + 4_000 * 0.5 + 1_500 * 8 + 500 * 8);
    expect(lunaCost).toBe(Math.round(6_000 * 0.2 + 4_000 * 0.05 + 1_500 * 0.8 + 500 * 0.8));

    const report = buildUsageReport(db);
    expect(report.models).toHaveLength(3);
    const byModel = new Map(report.models.map((row) => [row.model, row]));
    expect(byModel.get('gpt-5.6-sol')?.costMicros).toBe(solCost);
    expect(byModel.get('gpt-5.6-terra')?.costMicros).toBe(terraCost);
    expect(byModel.get('gpt-5.6-luna')?.costMicros).toBe(lunaCost);
    for (const row of report.models) {
      expect(row.events).toBe(1);
      expect(row.inputTokens).toBe(USAGE.input);
      expect(row.unknownCostEvents).toBe(0);
    }
    expect(report.totals.costMicros).toBe(solCost + terraCost + lunaCost);
    expect(report.totals.costComplete).toBe(true);
  });

  it('marks events for a model without a tariff as unknown-cost, never free', () => {
    const lunaCost = recordModelTurn('gpt-5.6-luna');
    recordUsageEvent(db, {
      createdAtMs: Date.now(),
      userId: 1,
      threadId: 't1',
      channel: 'web',
      model: 'gpt-5.6-unpriced',
      usage: USAGE,
      costMicros: computeUsageCostMicros(USAGE, PRICING, 'gpt-5.6-unpriced'),
    });

    const report = buildUsageReport(db);
    const unpriced = report.models.find((row) => row.model === 'gpt-5.6-unpriced');
    expect(unpriced?.costMicros).toBe(0);
    expect(unpriced?.unknownCostEvents).toBe(1);
    expect(report.totals.costComplete).toBe(false);
    expect(report.totals.costMicros).toBe(lunaCost);
  });
});
