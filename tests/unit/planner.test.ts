import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { updatePlan, getPlan, type PlanStep } from '../../src/agent/planner.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('planner', () => {
  it('creates a plan with steps', () => {
    const steps: PlanStep[] = [
      { id: 's1', title: 'Find item', status: 'pending', depends_on: [], notes: '' },
      { id: 's2', title: 'Get price', status: 'pending', depends_on: ['s1'], notes: '' },
    ];

    const plan = updatePlan(db, 'r1', 'find Rifter price', steps);
    expect(plan.requestId).toBe('r1');
    expect(plan.steps).toHaveLength(2);
  });

  it('retrieves a plan', () => {
    const steps: PlanStep[] = [
      { id: 's1', title: 'Step 1', status: 'done', depends_on: [], notes: 'ok' },
    ];
    updatePlan(db, 'r2', 'test', steps);

    const plan = getPlan(db, 'r2');
    expect(plan).not.toBeNull();
    expect(plan!.goal).toBe('test');
    expect(plan!.steps[0].status).toBe('done');
    expect(plan!.steps[0].notes).toBe('ok');
  });

  it('updates an existing plan', () => {
    updatePlan(db, 'r3', 'goal', [
      { id: 's1', title: 'Old', status: 'pending', depends_on: [], notes: '' },
    ]);

    updatePlan(db, 'r3', 'goal', [
      { id: 's1', title: 'Updated', status: 'done', depends_on: [], notes: 'finished' },
      { id: 's2', title: 'New step', status: 'pending', depends_on: ['s1'], notes: '' },
    ]);

    const plan = getPlan(db, 'r3');
    expect(plan!.steps).toHaveLength(2);
    expect(plan!.steps[0].title).toBe('Updated');
    expect(plan!.steps[1].depends_on).toEqual(['s1']);
  });

  it('returns null for non-existent plan', () => {
    expect(getPlan(db, 'nonexistent')).toBeNull();
  });
});
