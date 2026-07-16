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

export type PlanFailureCategory =
  | 'provider_failure'
  | 'tool_discovery_protocol'
  | 'tool_discovery_budget'
  | 'tool_state_failure'
  | 'iteration_budget'
  | 'deadline_exceeded'
  | 'identity_changed'
  | 'cancelled'
  | 'orchestration_failure';

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

/**
 * Atomically close a plan when its owning root turn can no longer continue.
 * Completed work is preserved, the active step is failed, and work that never
 * started is blocked. The fixed category is safe to persist and show in local
 * diagnostics; raw provider/private payloads must never be passed here.
 */
export function finalizePlanFailure(
  db: Db,
  requestId: string,
  category: PlanFailureCategory,
): Plan | null {
  const now = new Date().toISOString();
  const note = `Turn stopped: ${category}`;
  const cancelled = category === 'cancelled' || category === 'identity_changed';
  const runningStatus = cancelled ? 'blocked' : 'failed';
  const planStatus = cancelled ? 'cancelled' : 'failed';
  const finalize = db.transaction(() => {
    const plan = db.prepare('SELECT request_id FROM plans WHERE request_id = ?').get(requestId);
    if (!plan) return false;
    db.prepare(`
      UPDATE plan_steps
      SET status = ?,
          notes = CASE WHEN notes = '' THEN ? ELSE notes || ' | ' || ? END
      WHERE request_id = ? AND status = 'running'
    `).run(runningStatus, note, note, requestId);
    db.prepare(`
      UPDATE plan_steps
      SET status = 'blocked',
          notes = CASE WHEN notes = '' THEN ? ELSE notes || ' | ' || ? END
      WHERE request_id = ? AND status = 'pending'
    `).run(note, note, requestId);
    db.prepare(`
      UPDATE plans SET status = ?, updated_at = ? WHERE request_id = ?
    `).run(planStatus, now, requestId);
    return true;
  });
  return finalize() ? getPlan(db, requestId) : null;
}

export function finalizePlanCompletion(db: Db, requestId: string): Plan | null {
  const now = new Date().toISOString();
  const note = 'Turn completed before this step was explicitly updated';
  const finalize = db.transaction(() => {
    const plan = db.prepare('SELECT request_id FROM plans WHERE request_id = ?').get(requestId);
    if (!plan) return false;
    db.prepare(`
      UPDATE plan_steps SET status = 'done'
      WHERE request_id = ? AND status = 'running'
    `).run(requestId);
    db.prepare(`
      UPDATE plan_steps
      SET status = 'blocked',
          notes = CASE WHEN notes = '' THEN ? ELSE notes || ' | ' || ? END
      WHERE request_id = ? AND status = 'pending'
    `).run(note, note, requestId);
    db.prepare(`
      UPDATE plans SET status = 'completed', updated_at = ? WHERE request_id = ?
    `).run(now, requestId);
    return true;
  });
  return finalize() ? getPlan(db, requestId) : null;
}

/**
 * Called once during process startup, before any channel accepts work. Every
 * active plan then belongs to a previous process and cannot still have a live
 * worker. Unknown side effects are never replayed.
 */
export function recoverInterruptedPlans(db: Db): number {
  const requestIds = db.prepare(`
    SELECT request_id FROM plans WHERE status = 'active'
  `).all() as Array<{ request_id: string }>;
  for (const row of requestIds) {
    finalizePlanFailure(db, row.request_id, 'orchestration_failure');
  }
  return requestIds.length;
}

export function createRequestId(): string {
  return randomUUID();
}
