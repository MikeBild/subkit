import { z } from "@hono/zod-openapi";
import { and, eq, isNull, or } from "drizzle-orm";
import { conversations, workflows } from "../../db/schema/index.ts";
import { specQuestions } from "../authoring-spec.ts";
import { persistedWorkflowResource } from "../authoring-state/summary.ts";
import { hasInProgressWorkflowDraft, startNewWorkflowDraft } from "../authoring-state.ts";
import { hydrateBoundWorkflow } from "../draft.ts";
import { classifyDraftVsPersisted } from "../persistence/draft-diff.ts";
import { saveApprovalReadiness } from "../persistence/save-workflow-approval.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { clearLastPreview } from "./last-preview-store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z
  .object({
    workflow: z
      .string()
      .min(1)
      .describe("Slug or id of the saved workflow to open as this conversation's draft."),
    discard_unsaved: z
      .boolean()
      .optional()
      .describe(
        "Drop unsaved changes to the current draft. They stay recoverable with list_draft_snapshots / restore_draft_snapshot. Only set it when the person agreed to drop them.",
      ),
  })
  .openapi("OpenWorkflowDraftToolInput");

export async function resolveSavedWorkflow(ctx: ToolContext, ref: string) {
  const [row] = await ctx.db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      lifecycle: workflows.lifecycle,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, ctx.tenant_id),
        isNull(workflows.deleted_at),
        UUID.test(ref)
          ? or(eq(workflows.id, ref), eq(workflows.slug, ref))
          : eq(workflows.slug, ref),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function boundWorkflowIdOf(ctx: ToolContext): string | null {
  if (ctx.workflow_id) return ctx.workflow_id;
  const state = ctx.getDraft().state;
  return state ? (persistedWorkflowResource(state)?.id ?? null) : null;
}

async function hasUnsavedChanges(ctx: ToolContext, boundId: string | null): Promise<boolean> {
  const draft = ctx.getDraft();
  if ((draft.workflow?.steps.length ?? 0) === 0) return false;
  if (!boundId) return hasInProgressWorkflowDraft(draft);
  const diff = await classifyDraftVsPersisted(ctx.db, ctx.tenant_id, draft, boundId);
  return diff.state === "structural";
}

export const openWorkflowDraftTool: ConversationTool = {
  name: "open_workflow_draft",
  description:
    "Open a SAVED workflow as this conversation's draft, starting from its saved definition, so edit_workflow_patch changes that workflow. Use it to switch the draft to another existing workflow — never author_workflow, which builds a new one from scratch.",
  use_case:
    "The user wants to change or repair a workflow other than the one this conversation's draft holds, or edit_workflow_patch refused with draft_target_mismatch.",
  important_notes: [
    "Refuses with draft_has_unsaved_changes when the current draft differs from what is saved; save it first, or pass discard_unsaved:true once the person agreed to drop the changes (they stay recoverable as draft snapshots).",
    "The result's `target` names the workflow the draft now belongs to; pass that slug as `workflow` to edit_workflow_patch.",
  ],
  example_input: { workflow: "invoice-sync" },
  inputSchema,
  category: "draft_write",
  authoring_resource: "workflow",
  permission: {
    action: "workflow:read",
    resourceType: "workflow",
    resolveResourceId: async (ctx, rawArgs) => {
      const ref = typeof rawArgs.workflow === "string" ? rawArgs.workflow : null;
      if (!ref) return null;
      return (await resolveSavedWorkflow(ctx, ref))?.id ?? null;
    },
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const workflow = await resolveSavedWorkflow(ctx, args.workflow);
    if (!workflow) {
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "workflow_not_found",
          message: `no saved workflow "${args.workflow}" on this tenant`,
          recommended_mode: "workflow",
          next_best_actions: ["find_workflow", "list_workflows"],
        }),
      };
    }
    const target = { workflow_id: workflow.id, slug: workflow.slug, name: workflow.name };
    const boundId = boundWorkflowIdOf(ctx);
    if (boundId === workflow.id && (ctx.getDraft().workflow?.steps.length ?? 0) > 0) {
      return {
        ok: true,
        data: buildDraftMutationPayload(ctx.getDraft(), {
          resource_kind: "workflow",
          save_approval: await saveApprovalReadiness(ctx),
          extra: { target, already_open: true },
        }),
      };
    }
    if (args.discard_unsaved !== true && (await hasUnsavedChanges(ctx, boundId))) {
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "draft_has_unsaved_changes",
          message: `the current draft "${ctx.getDraft().workflow?.slug ?? ctx.getDraft().workflow?.name ?? "(unnamed)"}" has unsaved changes. Save it with save_workflow_draft, or ask the person whether to drop them and call open_workflow_draft again with discard_unsaved:true.`,
          recommended_mode: "workflow",
          next_best_actions: ["save_workflow_draft", "open_workflow_draft"],
          extra: { target },
        }),
      };
    }
    const reset = startNewWorkflowDraft(ctx.getDraft(), "workflow_opened");
    await ctx.db
      .update(conversations)
      .set({ target_workflow_id: workflow.id, updated_at: new Date() })
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      );
    const opened = await hydrateBoundWorkflow(
      ctx.tenant_id,
      workflow.id,
      reset,
      ctx.db,
      ctx.principal ?? undefined,
    );
    await ctx.setDraft(opened);
    ctx.workflow_id = workflow.id;
    clearLastPreview({ tenant_id: ctx.tenant_id, conversation_id: ctx.conversation_id });
    const questions = specQuestions(opened.workflow);
    return {
      ok: true,
      data: buildDraftMutationPayload(opened, {
        resource_kind: "workflow",
        save_approval: await saveApprovalReadiness(ctx),
        extra: {
          target,
          steps: opened.workflow.steps.length,
          step_ids: opened.workflow.steps.map((step) => step.id),
          spec: opened.workflow.spec ?? null,
          ...(questions
            ? {
                requires_user_input: true,
                spec_questions: questions.questions,
                user_prompt: questions.user_prompt,
                next_hint: questions.next_action,
              }
            : {}),
        },
      }),
    };
  },
};
