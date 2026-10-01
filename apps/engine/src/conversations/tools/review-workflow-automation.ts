import { z } from "@hono/zod-openapi";
import { can } from "../../rbac/evaluator.ts";
import { inspectAutomationReview, savedChangeReviewPath } from "../automation-review.ts";
import type { ConversationTool, ToolContext } from "./index.ts";
import { resolveConversationPrincipal } from "./permission-gate.ts";
import { resolvePublicBaseUrl } from "./usage-guidance.ts";

const Input = z.object({ workflow_id: z.string().uuid() });

/**
 * Whether this surface renders the review card. The cockpit chat does; an MCP
 * client, the CLI and external chat platforms have no such card, so the person
 * reaches the same review out of band, on the workflow's cockpit page.
 */
function rendersReviewCard(surface: ToolContext["surface"]): boolean {
  return surface === undefined || surface === "web";
}

/**
 * The review a person acts on: the workflow's automatic starts and the saved
 * change waiting to be applied. One builder for the review tool and for the
 * run refusal that promises this review, so the two cannot disagree.
 */
export async function buildAutomationReview(ctx: ToolContext, workflow_id: string) {
  // Hooks carry their own read permission, and a refusal's reason is
  // audit-log content — the same two probes the automation-status route
  // makes. No principal means nobody to grant the audit read to.
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
  // The run refusal reaches here on `workflow:run` alone; schedules stay behind
  // their own read permission, as on the tool's own gate.
  const review = (await allowed("schedule:read")) ? inspected : { ...inspected, schedules: [] };
  // A card with no rows renders as nothing. Ending the turn on it left the
  // side chat empty; with nothing to show, the model answers instead. A saved
  // change waiting to be applied IS something to show — with or without a
  // schedule — and the card is the only place a person applies it.
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

/** Read-only handoff to the existing exact-version browser review. */
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
