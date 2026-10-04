import type { ToolContext } from "../../index.ts";
import { buildAutomationReview } from "../../review-workflow-automation.ts";

export async function activationRequiredRefusal(
  ctx: ToolContext,
  versions: {
    workflow_id: string;
    draft_version_id: string | null;
    current_version_id: string | null;
  },
): Promise<Record<string, unknown>> {
  const review = await buildAutomationReview(ctx, versions.workflow_id);
  const where =
    review?.presentation === "automation_readiness_card"
      ? "The review card for it is shown in this chat with this result: there the person applies it and allows bounded runs. Point to that card in one short sentence. "
      : review?.review_url
        ? "Give the person review_url: there, signed in, they apply it and allow bounded runs. "
        : "";
  return {
    error_code: "workflow_activation_required",
    message:
      `The saved change needs human review. ${where}` +
      "Never offer an API call, a command, or leaving the conversation as a way around it, and never run an older version instead. No live run has occurred. " +
      "To PREVIEW the saved change itself, use `dry_run_workflow`: it runs this chat's draft with writes held and activates nothing.",
    ...versions,
    next_best_actions: ["dry_run_workflow"],
    user_action: "review_saved_change_in_chat",
    ...(review?.review_url ? { review_url: review.review_url } : {}),
    ...(review ? { automation_review: review } : {}),
  };
}
