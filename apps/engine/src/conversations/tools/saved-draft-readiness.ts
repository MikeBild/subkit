import { inspectAutomationReview } from "../automation-review.ts";
import type { ToolContext } from "./index.ts";

export interface SavedDraftReadiness {
  eligible_for_repeated_runs: boolean;
  message: string;
  issues?: Array<{ step_id: string; code: string }>;
  repair_guidance?: Array<{ step_id: string; code: string; instruction: string }>;
  unavailable_steps?: string[];
}

export async function savedDraftReadiness(
  ctx: Pick<ToolContext, "db" | "tenant_id">,
  workflow_id: string,
): Promise<SavedDraftReadiness | null> {
  let review: Awaited<ReturnType<typeof inspectAutomationReview>>;
  try {
    review = await inspectAutomationReview(ctx.db, ctx.tenant_id, workflow_id);
  } catch {
    return null;
  }
  if (!review) return null;
  if (review.schedules.length === 0) {
    if (!review.saved_change) return null;
    return {
      eligible_for_repeated_runs: review.saved_change.review.eligible_for_repeated_runs === true,
      message:
        "The saved change is not applied yet: nothing runs it until a person applies it. Hand over with `review_workflow_automation` — its card is where they apply it and allow bounded runs. Do not call `run_workflow` first, and never offer an API call or command instead.",
    };
  }
  const reviews = review.schedules.map((schedule) => schedule.review);
  if (reviews.some((entry) => entry.verification_unavailable)) return null;
  const issues = new Map<string, { step_id: string; code: string }>();
  const guidance = new Map<string, { step_id: string; code: string; instruction: string }>();
  const unavailable = new Set<string>();
  for (const entry of reviews) {
    for (const issue of entry.issues ?? []) issues.set(`${issue.step_id}:${issue.code}`, issue);
    for (const item of entry.repair_guidance ?? [])
      guidance.set(`${item.step_id}:${item.code}`, item);
    for (const step of entry.unavailable_steps ?? []) unavailable.add(step);
  }
  if (reviews.every((entry) => entry.eligible_for_repeated_runs === true))
    return {
      eligible_for_repeated_runs: true,
      message:
        "The saved change is eligible for repeated runs. Hand over with `review_workflow_automation`.",
    };
  return {
    eligible_for_repeated_runs: false,
    message:
      "The saved change is NOT yet eligible for repeated runs. Repair the steps below in THIS turn — " +
      "patch, preview, save again — and only then call `review_workflow_automation`: that tool ends " +
      "the turn, so nothing it reports can be repaired afterwards. A green preview does not mean " +
      "every boundary compiled.",
    issues: [...issues.values()],
    repair_guidance: [...guidance.values()],
    ...(unavailable.size > 0 ? { unavailable_steps: [...unavailable] } : {}),
  };
}
