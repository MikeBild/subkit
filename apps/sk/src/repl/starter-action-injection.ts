import type { OperatorHealthDigest } from "../engine-client.ts";
import {
  cliLocale,
  intakeReviewPrompt,
  type PendingIntake,
  terminalText,
} from "../lib/intake-review.ts";
import { totalFailureCount } from "../lib/operator-digest.ts";
import type { PersonaProbe } from "../slash.ts";
import { type StarterAction, starterActionsForPersona } from "./starter-actions.tsx";
import {
  findTaskActionById,
  starterTaskActionsForPersona,
  type TaskAction,
} from "./task-actions.ts";

export const TRIAGE_ACTION_ID = "triage-digest-failures";
export const REVIEW_INTAKE_ACTION_ID = "review-intake";
const REVIEW_INTAKE_PERMISSION = "intake:read";

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

export function shouldInjectIntakeReview(
  pending: PendingIntake | null | undefined,
  probe: PersonaProbe,
): pending is PendingIntake {
  if (!pending || pending.count <= 0) return false;
  return probe.allows(REVIEW_INTAKE_PERMISSION) && probe.allows("conversation:write");
}

export function intakeReviewAction(pending: PendingIntake): TaskAction {
  const category = terminalText(pending.category);
  return {
    id: REVIEW_INTAKE_ACTION_ID,
    label: `Review ${pending.count} collected item${pending.count === 1 ? "" : "s"} in “${category}”`,
    detail: "intake review",
    description: `Review collected items in “${category}” and propose what to retain. Nothing becomes knowledge or a skill until you confirm the proposal in Cockpit.`,
    category: "review",
    requires: REVIEW_INTAKE_PERMISSION,
    invoke: { kind: "prompt", prompt: intakeReviewPrompt(pending.category, cliLocale()) },
  };
}

function injectionPlan(
  digest: OperatorHealthDigest | null | undefined,
  probe: PersonaProbe,
  pendingIntake: PendingIntake | null | undefined,
): Array<{ action: TaskAction; label: string }> {
  const plan: Array<{ action: TaskAction; label: string }> = [];
  if (shouldInjectTriage(digest, probe)) {
    const action = findTaskActionById(TRIAGE_ACTION_ID);
    if (action) {
      const failCount = digest ? totalFailureCount(digest) : 0;
      plan.push({ action, label: `Fix ${failCount} failure${failCount === 1 ? "" : "s"}` });
    }
  }
  if (shouldInjectIntakeReview(pendingIntake, probe)) {
    const action = intakeReviewAction(pendingIntake);
    plan.push({ action, label: action.label });
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
  pendingIntake: PendingIntake | null = null,
): readonly StarterAction[] {
  const base = starterActionsForPersona(personaLabel, probe);
  const plan = injectionPlan(digest, probe, pendingIntake);
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
  pendingIntake: PendingIntake | null = null,
): readonly TaskAction[] {
  const base = starterTaskActionsForPersona(personaLabel, probe);
  const plan = injectionPlan(digest, probe, pendingIntake);
  if (plan.length === 0) return base;
  const injected = plan.map((entry, i) => ({ ...entry.action, key: String(i + 1) }));
  return [...injected, ...renumberDefaults(base, plan.length)];
}
