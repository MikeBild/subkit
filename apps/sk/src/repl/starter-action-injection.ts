import type { OperatorHealthDigest } from "../engine-client.ts";
import { totalFailureCount } from "../lib/operator-digest.ts";
import type { PersonaProbe } from "../slash.ts";
import { type StarterAction, starterActionsForPersona } from "./starter-actions.tsx";
import {
  findTaskActionById,
  starterTaskActionsForPersona,
  type TaskAction,
} from "./task-actions.ts";

export const TRIAGE_ACTION_ID = "triage-digest-failures";
export const REVIEW_LEARNINGS_ACTION_ID = "review-learnings";

const MAX_NUMBER_KEY = 9;

export function shouldInjectTriage(
  digest: OperatorHealthDigest | null | undefined,
  probe: PersonaProbe,
): boolean {
  if (!digest || digest.failure_groups.length === 0) return false;
  const action = findTaskActionById(TRIAGE_ACTION_ID);
  if (!action) return false;
  return !action.requires || probe.allows(action.requires);
}

export function shouldInjectLearnings(pendingLearnings: number, probe: PersonaProbe): boolean {
  if (pendingLearnings <= 0) return false;
  const action = findTaskActionById(REVIEW_LEARNINGS_ACTION_ID);
  if (!action) return false;
  return !action.requires || probe.allows(action.requires);
}

function injectionPlan(
  digest: OperatorHealthDigest | null | undefined,
  probe: PersonaProbe,
  pendingLearnings: number,
): Array<{ action: TaskAction; label: string }> {
  const plan: Array<{ action: TaskAction; label: string }> = [];
  if (shouldInjectTriage(digest, probe)) {
    const action = findTaskActionById(TRIAGE_ACTION_ID);
    if (action) {
      const failCount = digest ? totalFailureCount(digest) : 0;
      plan.push({ action, label: `Fix ${failCount} failure${failCount === 1 ? "" : "s"}` });
    }
  }
  if (shouldInjectLearnings(pendingLearnings, probe)) {
    const action = findTaskActionById(REVIEW_LEARNINGS_ACTION_ID);
    if (action) {
      plan.push({
        action,
        label: `Review ${pendingLearnings} proposed learning${pendingLearnings === 1 ? "" : "s"}`,
      });
    }
  }
  return plan;
}

function renumberDefaults<T extends { key?: string | undefined }>(
  actions: readonly T[],
  injectedCount: number,
): T[] {
  return actions
    .slice(0, Math.max(0, MAX_NUMBER_KEY - injectedCount))
    .map((action, i) => ({ ...action, key: String(i + 1 + injectedCount) }));
}

export function buildStarterActions(
  personaLabel: string,
  probe: PersonaProbe,
  digest: OperatorHealthDigest | null | undefined,
  pendingLearnings = 0,
): readonly StarterAction[] {
  const base = starterActionsForPersona(personaLabel, probe);
  const plan = injectionPlan(digest, probe, pendingLearnings);
  if (plan.length === 0) return base;
  const injected: StarterAction[] = plan.map((entry, i) => ({
    key: String(i + 1),
    label: entry.label,
    detail: entry.action.detail,
    actionId: entry.action.id,
  }));
  return [...injected, ...renumberDefaults(base, plan.length)];
}

export function buildStarterTaskActions(
  personaLabel: string,
  probe: PersonaProbe,
  digest: OperatorHealthDigest | null | undefined,
  pendingLearnings = 0,
): readonly TaskAction[] {
  const base = starterTaskActionsForPersona(personaLabel, probe);
  const plan = injectionPlan(digest, probe, pendingLearnings);
  if (plan.length === 0) return base;
  const injected = plan.map((entry, i) => ({ ...entry.action, key: String(i + 1) }));
  return [...injected, ...renumberDefaults(base, plan.length)];
}
