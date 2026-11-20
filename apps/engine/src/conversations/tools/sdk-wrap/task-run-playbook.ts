import { PlaybookDocumentSchema, PlaybookPlanSchema } from "../../playbook-contract.ts";
import { readConversationPlaybookDocument } from "../../service/tool-state.ts";
import type { ToolContext, ToolResult } from "../index.ts";

export const TASK_RUN_CONFIRM_STEP_ID = "confirm-result";

const MAY_CHANGE =
  "You may add, change and reorder your own steps. Keep the goal, keep the step `confirm-result` with its human_confirmation question unchanged, keep completion_step_id set to `confirm-result`, and keep cancelled false.";

function refusal(error_code: string, problem: string): ToolResult {
  const message = `${problem} The plan was not changed. ${MAY_CHANGE}`;
  return {
    ok: false,
    error_code,
    message,
    data: {
      error: { code: error_code, message },
      error_code,
      next_best_actions: ["update_playbook"],
    },
  };
}

export async function taskRunPlaybookRefusal(
  ctx: Pick<ToolContext, "db" | "tenant_id" | "conversation_id">,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  const next = PlaybookPlanSchema.safeParse(args.plan);
  if (!next.success) return null;
  const stored = PlaybookDocumentSchema.safeParse(
    await readConversationPlaybookDocument(ctx.db, ctx),
  );
  const baseline = stored.success
    ? stored.data.plan.steps.find((step) => step.id === TASK_RUN_CONFIRM_STEP_ID)
    : undefined;
  if (!stored.success || baseline?.criterion.kind !== "human_confirmation")
    return refusal(
      "task_run_plan_missing",
      "This task run has no stored plan with a final confirmation to compare against.",
    );
  const plan = next.data;
  if (plan.cancelled)
    return refusal("task_run_plan_cancel_refused", "A task run cannot cancel its own plan.");
  if (plan.goal !== stored.data.plan.goal)
    return refusal("task_run_plan_goal_changed", "The goal of a task run cannot be changed.");
  const confirm = plan.steps.find((step) => step.id === TASK_RUN_CONFIRM_STEP_ID);
  if (!confirm)
    return refusal(
      "task_run_plan_confirmation_missing",
      "The plan must keep the step `confirm-result`.",
    );
  if (
    confirm.criterion.kind !== "human_confirmation" ||
    confirm.criterion.question !== baseline.criterion.question
  )
    return refusal(
      "task_run_plan_confirmation_changed",
      "The step `confirm-result` must stay a human confirmation with its original question.",
    );
  if (plan.completion_step_id !== TASK_RUN_CONFIRM_STEP_ID)
    return refusal(
      "task_run_plan_completion_changed",
      "completion_step_id must stay `confirm-result`.",
    );
  return null;
}
