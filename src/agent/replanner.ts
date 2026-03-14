import type { Db } from '../db/sqlite.js';
import { getPlan, updatePlan, type PlanStep } from './planner.js';

/**
 * Replanning logic.
 * Checks if any steps failed and adjusts the plan.
 * Called by the executor when a tool call returns an error.
 */
export function replanOnFailure(
  db: Db,
  requestId: string,
  failedStepId: string,
  errorMessage: string,
): { replanned: boolean; plan: ReturnType<typeof getPlan> } {
  const plan = getPlan(db, requestId);
  if (!plan) {
    return { replanned: false, plan: null };
  }

  const updatedSteps: PlanStep[] = plan.steps.map((step) => {
    if (step.id === failedStepId) {
      return { ...step, status: 'failed' as const, notes: errorMessage };
    }
    // Block steps that depend on the failed step
    if (step.depends_on.includes(failedStepId) && step.status === 'pending') {
      return { ...step, status: 'blocked' as const, notes: `Blocked: dependency ${failedStepId} failed` };
    }
    return step;
  });

  const updated = updatePlan(db, requestId, plan.goal, updatedSteps);
  return { replanned: true, plan: updated };
}
