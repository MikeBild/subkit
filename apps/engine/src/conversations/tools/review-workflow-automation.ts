import { z } from "@hono/zod-openapi";
import { can } from "../../rbac/evaluator.ts";
import {
  assessVersionEnvironments,
  describeAuthorityEnvironments,
} from "../../workflows/authority-environments.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { getWorkflow } from "../../workflows/service.ts";
import { inspectAutomationReview, savedChangeReviewPath } from "../automation-review.ts";
import { conversationExecutionSuppression } from "../execution-suppression.ts";
import type { ConversationTool, ToolContext } from "./index.ts";
import { resolveConversationPrincipal } from "./permission-gate.ts";
import { resolvePublicBaseUrl } from "./usage-guidance.ts";

const Input = z.object({ workflow_id: z.string().uuid() });

function rendersReviewCard(surface: ToolContext["surface"]): boolean {
  return surface === undefined || surface === "web";
}

async function liveExecutionSuppressed(ctx: ToolContext): Promise<boolean> {
  return (
    await conversationExecutionSuppression({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      recent_user_message: ctx.recentUserMessage ?? null,
    })
  ).live;
}

async function environmentNote(ctx: ToolContext, workflow_id: string): Promise<string | null> {
  const workflow = await getWorkflow(ctx.tenant_id, workflow_id, ctx.db);
  const workflow_version_id = workflow?.draft_version_id ?? workflow?.current_version_id;
  if (!workflow_version_id) return null;
  try {
    return describeAuthorityEnvironments(
      await assessVersionEnvironments(ctx.db, {
        tenant_id: ctx.tenant_id,
        workflow_id,
        workflow_version_id,
      }),
    );
  } catch {
    return null;
  }
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
  const environment_note = await environmentNote(ctx, workflow_id);
  return {
    kind: "workflow_automation_review" as const,
    presentation: card ? ("automation_readiness_card" as const) : ("text" as const),
    ...review,
    ...(review_url ? { review_url } : {}),
    ...(environment_note ? { environment_note } : {}),
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
    "Hand off to the user-facing review card for a workflow in this chat: its automatic runs (schedules, inbound webhooks) and a saved change that still has to be applied before the workflow can run. Use after inspecting and preparing the workflow, when run_workflow answers workflow_activation_required, or when the user asks for its current readiness. When there is something to review this ends the turn with a structured card; do not narrate internal diagnosis before calling it. When there is nothing (no schedule, no webhook, no unapplied saved change) there is no card: answer the user in prose from the result. The browser dialog separately checks the exact version, effects and finite limits. A completed DEV preparation records one pending test for this exact version unless the user said not to run live, not to activate or not to cause live effects. Never substitute ask_user_confirm, a single run, or an API call: none of them applies a saved change or grants recurring authority.",
  inputSchema: Input,
  category: "tenant_read",
  permission: { action: "schedule:read", resourceType: "schedule" },
  async execute(ctx, raw) {
    const { workflow_id } = Input.parse(raw);
    const review = await buildAutomationReview(ctx, workflow_id);
    if (!review) return { ok: false, error_code: "workflow_not_found" };
    const saved = review.saved_change;
    const draft = ctx.getDraft();
    const persisted = draft.summary?.persisted_resources.find(
      (resource) => resource.kind === "workflow" && resource.id === workflow_id,
    );
    const preview = draft.latest_preview;
    const persistedCheckpoint = draft.state?.checkpoints.workflow_persisted;
    const previewCheckpoint = draft.state?.checkpoints.workflow_previewed;
    const inputDigest = preview?.input === undefined ? null : workflowJsonDigest(preview.input);
    if (
      saved?.environment === "dev" &&
      saved.workflow_version_id &&
      persisted?.version_id === saved.workflow_version_id &&
      persistedCheckpoint?.ok === true &&
      persistedCheckpoint.mutation_seq === draft.state?.workflow_mutation_seq &&
      previewCheckpoint?.ok === true &&
      previewCheckpoint.mutation_seq === draft.state?.workflow_mutation_seq &&
      preview?.ok === true &&
      preview.input !== undefined &&
      inputDigest !== null &&
      !(await liveExecutionSuppressed(ctx))
    ) {
      const existing = draft.session?.live_test;
      if (
        !existing ||
        existing.workflow_id !== workflow_id ||
        existing.workflow_version_id !== saved.workflow_version_id ||
        existing.input_digest !== inputDigest ||
        existing.state === "failed" ||
        existing.state === "blocked"
      ) {
        await ctx.setDraft({
          ...draft,
          session: {
            ...(draft.session ?? {}),
            live_test: {
              workflow_id,
              workflow_version_id: saved.workflow_version_id,
              environment: "dev",
              input: preview.input,
              input_digest: inputDigest,
              idempotency_key: `conversation-live-test:${ctx.conversation_id}:${saved.workflow_version_id}:${inputDigest}`,
              state: "pending",
            },
          },
        });
      }
    }
    return { ok: true, data: review };
  },
};
