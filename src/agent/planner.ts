import type { Db } from '../db/sqlite.js';
import { randomUUID } from 'node:crypto';

export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'blocked' | 'failed';
  depends_on: string[];
  notes: string;
}

export interface Plan {
  requestId: string;
  goal: string;
  status: string;
  steps: PlanStep[];
}

/**
 * Tool handler for update_plan.
 * Creates or replaces the plan for a given request.
 */
export function updatePlan(db: Db, requestId: string, goal: string, steps: PlanStep[]): Plan {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO plans (request_id, goal, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      goal = excluded.goal,
      updated_at = excluded.updated_at
  `).run(requestId, goal, now, now);

  // Replace all steps
  db.prepare('DELETE FROM plan_steps WHERE request_id = ?').run(requestId);

  const insertStep = db.prepare(`
    INSERT INTO plan_steps (request_id, step_id, title, kind, status, depends_on_json, notes)
    VALUES (?, ?, ?, 'action', ?, ?, ?)
  `);

  const insertAll = db.transaction((planSteps: PlanStep[]) => {
    for (const step of planSteps) {
      insertStep.run(requestId, step.id, step.title, step.status, JSON.stringify(step.depends_on), step.notes);
    }
  });

  insertAll(steps);

  return { requestId, goal, status: 'active', steps };
}

/**
 * Delete plans (and their steps) older than the retention window. Each request
 * mints a fresh request_id, so plans/plan_steps otherwise grow without bound.
 */
export function prunePlans(db: Db, retentionDays = 7): number {
  const steps = db.prepare(
    "DELETE FROM plan_steps WHERE request_id IN (SELECT request_id FROM plans WHERE created_at < datetime('now', ?))",
  ).run(`-${retentionDays} days`);
  db.prepare("DELETE FROM plans WHERE created_at < datetime('now', ?)").run(`-${retentionDays} days`);
  return steps.changes;
}

/**
 * Get existing plan for a request.
 */
export function getPlan(db: Db, requestId: string): Plan | null {
  const plan = db.prepare('SELECT * FROM plans WHERE request_id = ?').get(requestId) as
    | { request_id: string; goal: string; status: string }
    | undefined;

  if (!plan) return null;

  const rows = db.prepare('SELECT * FROM plan_steps WHERE request_id = ? ORDER BY rowid').all(requestId) as Array<{
    step_id: string;
    title: string;
    status: string;
    depends_on_json: string;
    notes: string;
  }>;

  return {
    requestId: plan.request_id,
    goal: plan.goal,
    status: plan.status,
    steps: rows.map((r) => ({
      id: r.step_id,
      title: r.title,
      status: r.status as PlanStep['status'],
      depends_on: JSON.parse(r.depends_on_json),
      notes: r.notes,
    })),
  };
}

export function createRequestId(): string {
  return randomUUID();
}
