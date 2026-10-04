import { z } from "@hono/zod-openapi";
import { can } from "../../rbac/evaluator.ts";
import { inspectAutomationReview, savedChangeReviewPath } from "../automation-review.ts";
import type { ConversationTool, ToolContext } from "./index.ts";
import { resolveConversationPrincipal } from "./permission-gate.ts";
import { resolvePublicBaseUrl } from "./usage-guidance.ts";

const Input = z.object({ workflow_id: z.string().uuid() });

function rendersReviewCard(surface: ToolContext["surface"]): boolean {
  return surface === undefined || surface === "web";
}

export async function buildAutomationReview(ctx: ToolContext, workflow_id: string) {
  const principal = ctx.principal ?? (await resolveConversationPrincipal(ctx));
  const allowed = async (permission: "schedule:read" | "inbound_hook:read" | "audit:read") =>
    principal
      ? (await can(ctx.db, { tenant_id: ctx.tenant_id, principal, permission, quiet: true })).allow
      : permission !== "audit:read";
  const inspected = await inspectAutomationReview(ctx.db, ctx.tenant_id, workflow_id, {
    ...((await allowed("inbound_hook:read"))
      ? { inbound_hooks: { refusal_reasons: await allowed("audit:read") } }
      : {}),
  });
  if (!inspected) return null;
  const review = (await allowed("schedule:read")) ? inspected : { ...inspected, schedules: [] };
  const hasContent =
    review.schedules.length + (review.inbound_hooks?.length ?? 0) > 0 ||
    review.saved_change !== null;
  const base = resolvePublicBaseUrl();
  const review_url = hasContent ? `${base ?? ""}${savedChangeReviewPath(workflow_id)}` : undefined;
  const card = hasContent && rendersReviewCard(ctx.surface);
  return {
    kind: "workflow_automation_review" as const,
    presentation: card ? ("automation_readiness_card" as const) : ("text" as const),
    ...review,
    ...(review_url ? { review_url } : {}),
    next_action: card
      ? "Use the review card in this chat. It rechecks the latest saved version; there the person applies a saved change and allows bounded runs. Do not ask a generic confirmation, run or activate anything, or claim permission was granted. Only authorized schedule, webhook or activation state confirms completion."
      : review_url
        ? "This surface has no review card. Give the person review_url: there, signed in, they review the saved change and its automatic starts, apply it and allow bounded runs. Nothing ran and nothing was applied. You cannot apply or approve it yourself, and never offer an API call or command instead."
        : "Nothing starts this workflow automatically and no saved change waits to be applied: it has no schedule and no inbound webhook, so there is no card. Answer the user in one or two sentences, in their language, from this result.",
  };
}

export const reviewWorkflowAutomationTool: ConversationTool = {
  name: "review_workflow_automation",
  description:
    "Hand off to the user-facing review card for a workflow in this chat: its automatic runs (schedules, inbound webhooks) and a saved change that still has to be applied before the workflow can run. Use after inspecting and preparing the workflow, when run_workflow answers workflow_activation_required, or when the user asks for its current readiness. When there is something to review this ends the turn with a structured card; do not narrate internal diagnosis before calling it. When there is nothing (no schedule, no webhook, no unapplied saved change) there is no card: answer the user in prose from the result. This reads status only; the browser dialog separately checks the exact version, effects and finite limits. Never substitute ask_user_confirm, a single run, or an API call: none of them applies a saved change or grants recurring authority.",
  inputSchema: Input,
  category: "tenant_read",
  permission: { action: "schedule:read", resourceType: "schedule" },
  async execute(ctx, raw) {
    const { workflow_id } = Input.parse(raw);
    const review = await buildAutomationReview(ctx, workflow_id);
    if (!review) return { ok: false, error_code: "workflow_not_found" };
    return { ok: true, data: review };
  },
};
