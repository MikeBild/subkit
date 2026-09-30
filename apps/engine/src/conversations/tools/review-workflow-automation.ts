import { z } from "@hono/zod-openapi";
import { can } from "../../rbac/evaluator.ts";
import { inspectAutomationReview } from "../automation-review.ts";
import type { ConversationTool } from "./index.ts";
import { resolveConversationPrincipal } from "./permission-gate.ts";

const Input = z.object({ workflow_id: z.string().uuid() });

/** Read-only handoff to the existing exact-version browser review. */
export const reviewWorkflowAutomationTool: ConversationTool = {
  name: "review_workflow_automation",
  description:
    "Hand off to a user-facing readiness and approval card for the workflow's automatic runs — its schedules and inbound webhooks — in this chat. Use after inspecting and preparing the workflow, or when the user asks for its current readiness. When the workflow has a schedule or webhook this ends the turn with a structured card; do not narrate internal diagnosis before calling it. When it has neither there is no card: answer the user in prose from the result. This reads status only; the browser dialog separately checks the exact version, effects and finite limits. Never substitute ask_user_confirm or a single run: neither grants recurring authority.",
  inputSchema: Input,
  category: "tenant_read",
  permission: { action: "schedule:read", resourceType: "schedule" },
  async execute(ctx, raw) {
    const { workflow_id } = Input.parse(raw);
    // Hooks carry their own read permission, and a refusal's reason is
    // audit-log content — the same two probes the automation-status route
    // makes. No principal means nobody to grant the audit read to.
    const principal = ctx.principal ?? (await resolveConversationPrincipal(ctx));
    const allowed = async (permission: "inbound_hook:read" | "audit:read") =>
      principal
        ? (await can(ctx.db, { tenant_id: ctx.tenant_id, principal, permission, quiet: true }))
            .allow
        : permission === "inbound_hook:read";
    const review = await inspectAutomationReview(ctx.db, ctx.tenant_id, workflow_id, {
      ...((await allowed("inbound_hook:read"))
        ? { inbound_hooks: { refusal_reasons: await allowed("audit:read") } }
        : {}),
    });
    if (!review) return { ok: false, error_code: "workflow_not_found" };
    // A card with no rows renders as nothing. Ending the turn on it left the
    // side chat empty; with nothing to show, the model answers instead.
    const card = review.schedules.length + (review.inbound_hooks?.length ?? 0) > 0;
    return {
      ok: true,
      data: {
        kind: "workflow_automation_review",
        presentation: card ? "automation_readiness_card" : "text",
        ...review,
        next_action: card
          ? "Use the review card in this chat. It rechecks the latest saved version. Do not ask a generic confirmation, run or activate anything, or claim permission was granted. Only authorized schedule or webhook state confirms completion."
          : "Nothing starts this workflow automatically: it has no schedule and no inbound webhook, so there is no card. Answer the user in one or two sentences, in their language, from this result.",
      },
    };
  },
};
