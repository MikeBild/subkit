import { z } from "@hono/zod-openapi";
import { inspectAutomationReview } from "../automation-review.ts";
import type { ConversationTool } from "./index.ts";

const Input = z.object({ workflow_id: z.string().uuid() });

/** Read-only handoff to the existing exact-version browser review. */
export const reviewWorkflowAutomationTool: ConversationTool = {
  name: "review_workflow_automation",
  description:
    "Review readiness for recurring automatic runs and show the real bounded execution review in this chat. Use this when the user wants to resolve a blocked schedule or authorize recurring delivery. This reads status only; the browser dialog separately checks the exact version, effects and finite limits. Never substitute ask_user_confirm or a single run: neither grants recurring authority. After this tool, briefly explain the next step and let the user use its review card.",
  inputSchema: Input,
  category: "tenant_read",
  permission: { action: "schedule:read", resourceType: "schedule" },
  async execute(ctx, raw) {
    const { workflow_id } = Input.parse(raw);
    const review = await inspectAutomationReview(ctx.db, ctx.tenant_id, workflow_id);
    if (!review) return { ok: false, error_code: "workflow_not_found" };
    return {
      ok: true,
      data: {
        kind: "workflow_automation_review",
        ...review,
        next_action:
          "Use the review card in this chat. It rechecks the latest saved version. Do not ask a generic confirmation, run or activate anything, or claim permission was granted. Only authorized schedule state confirms completion.",
      },
    };
  },
};
