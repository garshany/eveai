import type { Db } from '../db/sqlite.js';
import { getPlan, updatePlan, type PlanStep } from './planner.js';

/**
 * Replanning logic.
 * When a tool call fails, find the currently "running" step in the plan
 * and mark it as failed, then block its dependents.
 */
export function replanOnFailure(
  db: Db,
  requestId: string,
  errorMessage: string,
): { replanned: boolean; plan: ReturnType<typeof getPlan> } {
  const plan = getPlan(db, requestId);
  if (!plan) {
    return { replanned: false, plan: null };
  }

  // Find the first "running" step -- that's the one that likely failed
  const runningStep = plan.steps.find((s) => s.status === 'running');
  if (!runningStep) {
    // No running step to fail -- nothing to replan
    return { replanned: false, plan };
  }

  const failedStepId = runningStep.id;

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
