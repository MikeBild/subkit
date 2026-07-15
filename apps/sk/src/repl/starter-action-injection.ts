// Digest- and learnings-driven starter-action injection.
//
// When the startup health digest carries failures and the persona may run the
// triage action, the REPL prepends a "guided triage" entry keyed "1". When
// proposed session learnings are pending and the persona may read skills, a
// "review learnings" entry takes the next free number. The persona defaults
// renumber after the injected entries — keeping the rendered list and the
// dispatch list (number-key handler) aligned. This logic lives here, shared by
// ink-app.tsx and its tests, so the two can never drift.

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

// Injected entries take keys "1".. in plan order (triage first, then
// learnings); the persona defaults shift to the next free number — capped so a
// single-char number key never exceeds "9". Overflow entries are dropped
// rather than clamped onto a shared key. Today's persona defaults have 5
// entries and at most 2 injections, so this never trips; the cap is a
// defensive invariant.
const MAX_NUMBER_KEY = 9;

/** Whether to inject the guided-triage starter action: the digest must carry
 *  failures AND the persona must hold the triage action's required permission.
 *  The single RBAC + failure gate — render and dispatch both derive from it. */
export function shouldInjectTriage(
  digest: OperatorHealthDigest | null | undefined,
  probe: PersonaProbe,
): boolean {
  if (!digest || digest.failure_groups.length === 0) return false;
  const action = findTaskActionById(TRIAGE_ACTION_ID);
  if (!action) return false;
  return !action.requires || probe.allows(action.requires);
}

/** Whether to inject the review-learnings starter action: proposed session
 *  learnings must be pending AND the persona must hold the action's required
 *  permission. Same single-gate contract as shouldInjectTriage. */
export function shouldInjectLearnings(pendingLearnings: number, probe: PersonaProbe): boolean {
  if (pendingLearnings <= 0) return false;
  const action = findTaskActionById(REVIEW_LEARNINGS_ACTION_ID);
  if (!action) return false;
  return !action.requires || probe.allows(action.requires);
}

/** Injection plan shared by render + dispatch: the TaskActions to prepend, in
 *  key order, each with its count-aware render label. Deriving both lists from
 *  this one plan is what keeps their number keys aligned. */
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

/** Render list: persona starter actions (RBAC-filtered by `probe`), with the
 *  triage / review-learnings entries prepended at keys "1".. when the digest,
 *  pending-learnings count, and permissions warrant it. The injection decision
 *  is derived internally via the shared plan so it can never be passed in
 *  inconsistently with the probe. */
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

/** Dispatch list (drives the number-key handler): persona task actions, with
 *  the injected TaskActions prepended at keys "1".. under the same plan.
 *  Mirrors buildStarterActions so render and dispatch keys stay aligned. */
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
