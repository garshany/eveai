import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '0.0.0.0' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
  },
}));

import { updatePlan, type PlanStep } from '../../src/agent/planner.js';
import { replanOnFailure } from '../../src/agent/replanner.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('replanOnFailure', () => {
  it('returns replanned=false when no plan exists', () => {
    const result = replanOnFailure(db, 'nonexistent', 'some error');
    expect(result.replanned).toBe(false);
    expect(result.plan).toBeNull();
  });

  it('returns replanned=false when no step is running', () => {
    updatePlan(db, 'r1', 'test goal', [
      { id: 's1', title: 'Step 1', status: 'pending', depends_on: [], notes: '' },
    ]);
    const result = replanOnFailure(db, 'r1', 'error');
    expect(result.replanned).toBe(false);
  });

  it('marks the running step as failed', () => {
    updatePlan(db, 'r1', 'test goal', [
      { id: 's1', title: 'Find item', status: 'done', depends_on: [], notes: '' },
      { id: 's2', title: 'Get price', status: 'running', depends_on: ['s1'], notes: '' },
      { id: 's3', title: 'Calculate', status: 'pending', depends_on: ['s2'], notes: '' },
    ]);

    const result = replanOnFailure(db, 'r1', 'ESI returned 404');
    expect(result.replanned).toBe(true);

    const steps = result.plan!.steps;
    expect(steps[0].status).toBe('done');     // s1 unchanged
    expect(steps[1].status).toBe('failed');   // s2 was running -> failed
    expect(steps[1].notes).toBe('ESI returned 404');
    expect(steps[2].status).toBe('blocked');  // s3 depends on s2 -> blocked
    expect(steps[2].notes).toContain('dependency s2 failed');
  });

  it('only fails the first running step', () => {
    updatePlan(db, 'r1', 'goal', [
      { id: 's1', title: 'A', status: 'running', depends_on: [], notes: '' },
      { id: 's2', title: 'B', status: 'running', depends_on: [], notes: '' },
    ]);

    const result = replanOnFailure(db, 'r1', 'timeout');
    const steps = result.plan!.steps;
    expect(steps[0].status).toBe('failed');   // first running
    expect(steps[1].status).toBe('running');  // second running untouched
  });

  it('does not block steps that do not depend on the failed step', () => {
    updatePlan(db, 'r1', 'goal', [
      { id: 's1', title: 'A', status: 'running', depends_on: [], notes: '' },
      { id: 's2', title: 'B', status: 'pending', depends_on: [], notes: '' },
      { id: 's3', title: 'C', status: 'pending', depends_on: ['s1'], notes: '' },
    ]);

    const result = replanOnFailure(db, 'r1', 'fail');
    const steps = result.plan!.steps;
    expect(steps[1].status).toBe('pending');  // s2 has no dependency on s1
    expect(steps[2].status).toBe('blocked');  // s3 depends on s1
  });
});
