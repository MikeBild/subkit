// commit_draft — persist the draft as a real workflow.
//
// Requires a prior `ask_user_confirm { kind: "commit_draft" }`
// elicitation resolved with `{ confirmed: true }` plus fresh inspect /
// validate / preview checkpoints. On success the workflow id is
// recorded on the conversation and the loop ends.

import { z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { conversationElicitations, conversations, workflows } from "../../db/schema/index.ts";
import { createWorkflow, updateWorkflow } from "../../workflows/service.ts";
import { getWorkflowDraft, withWorkflowPersisted } from "../authoring-state.ts";
import {
  buildGateError,
  buildPersistencePayload,
  missingFreshCheckpoints,
} from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("CommitDraftToolInput");

export const commitDraftTool: ConversationTool = {
  name: "commit_draft",
  description:
    "Persist the draft as a workflow — creates a new one or updates the one the conversation targets.",
  use_case:
    "Final step when the operator has confirmed via ask_user_confirm(kind='commit_draft') that the draft is ready to save. If the conversation has a target_workflow_id, commits a new workflow_version on that row. If the draft's slug matches an existing live workflow of this tenant, adopts that workflow as the target and updates it in-place. Otherwise creates a new workflow row.",
  important_notes: [
    "Refuses with `no_prior_approval` if no matching ask_user_confirm has been answered in this conversation.",
    "Refuses with `workflow_not_ready` until inspect_workflow_draft, validate_draft, and dry_run_step/dry_run_workflow are all fresh and successful.",
    "Update-in-place semantics: if conversations.target_workflow_id is set, this tool appends a new workflow_version to that workflow. The slug of the existing workflow stays authoritative; changing draft.slug does not rename the workflow.",
    "Adopt-on-slug-match: if no target is set but draft.slug matches a live workflow, adopts it as the target and updates. Never creates a sibling workflow with a fresh slug — that was the old behavior that produced zombie workflows.",
    "On duplicate_slug errors, the error payload includes `conflict.workflow_id` so the caller can choose to update (call commit_draft again) or pick a different slug.",
    "Writes exactly one audit row per save (workflow_created or workflow_updated) and one outbox event.",
  ],
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    inputSchema.parse(rawArgs);
    // Must have at least one resolved `ask_user_confirm` elicitation
    // whose input.kind is "commit_draft" and output.confirmed is true.
    const rows = await ctx.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, ctx.tenant_id),
          eq(conversationElicitations.conversation_id, ctx.conversation_id),
          eq(conversationElicitations.tool_name, "ask_user_confirm"),
          sql`(${conversationElicitations.input} ->> 'kind') = 'commit_draft'`,
        ),
      )
      .orderBy(desc(conversationElicitations.created_at))
      .limit(1);
    const head = rows[0];
    const confirmed =
      head?.status === "resolved" &&
      typeof head.output === "object" &&
      head.output !== null &&
      (head.output as { confirmed?: unknown }).confirmed === true;
    if (!head || !confirmed) {
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "no_prior_approval",
          message:
            "commit_draft requires a resolved ask_user_confirm { kind: commit_draft, confirmed: true }",
          recommended_mode: "workflow",
          next_best_actions: ["ask_user_confirm"],
          extra: {
            latest_elicitation_status: head?.status ?? null,
          },
        }),
      };
    }

    const fullDraft = ctx.getDraft();
    const latestPreview = fullDraft.latest_preview;
    const staleCheckpoints = missingFreshCheckpoints(fullDraft, [
      "workflow_inspected",
      "workflow_validated",
      "workflow_previewed",
    ]);
    const blocking_reasons = [
      ...(fullDraft.summary?.blocked_by ?? []).filter(
        (reason) =>
          reason === "inspect_workflow_draft" ||
          reason === "validate_draft" ||
          reason === "dry_run_workflow" ||
          reason.startsWith("missing:"),
      ),
    ];
    if (
      staleCheckpoints.length > 0 ||
      !latestPreview ||
      latestPreview.ok !== true ||
      blocking_reasons.length > 0
    ) {
      return {
        ok: false,
        data: buildGateError(fullDraft, {
          error_code: "workflow_not_ready",
          message: "workflow commit is blocked until inspection, validation, and preview are fresh",
          stale_checkpoints: staleCheckpoints,
          blocking_reasons,
          recommended_mode: "workflow",
          extra: {
            latest_preview: latestPreview ?? null,
          },
        }),
      };
    }

    const draft = getWorkflowDraft(fullDraft);
    // Drop any non-workflow helper fields (e.g. edges hint) before
    // the validator sees them.
    const def = {
      name: draft.name,
      ...(draft.slug ? { slug: draft.slug } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.input_schema ? { input_schema: draft.input_schema } : {}),
      ...(draft.output_schema ? { output_schema: draft.output_schema } : {}),
      steps: draft.steps,
    };

    // Decide save mode: update an existing workflow, adopt one whose
    // slug matches the draft, or create a new row. The three branches:
    //
    //   1. target_workflow_id set on conversation → update that row.
    //      The slug on the existing row is authoritative; a new slug
    //      in the draft is ignored so the identifier stays stable
    //      across edits.
    //
    //   2. No target set, draft.slug matches a LIVE workflow of this
    //      tenant → adopt: set target_workflow_id on the conversation,
    //      then update. This catches the "user re-saves with the same
    //      slug" case that used to loop on slug-conflict errors.
    //
    //   3. Draft.slug matches a SOFT-DELETED workflow → because the
    //      unique index is now partial (WHERE deleted_at IS NULL), the
    //      slug is already free and we fall through to createWorkflow.
    //      No resurrect — the user asked for a new row; the tombstone
    //      stays in history.
    //
    //   4. Otherwise → create. On success we persist the new id as
    //      target_workflow_id so the next commit_draft updates in-place.
    const convRows = await ctx.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, ctx.conversation_id))
      .limit(1);
    let targetWorkflowId = convRows[0]?.target_workflow_id ?? null;

    if (!targetWorkflowId && def.slug) {
      const slugRows = await ctx.db
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, ctx.tenant_id),
            eq(workflows.slug, def.slug),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1);
      if (slugRows[0]) {
        targetWorkflowId = slugRows[0].id;
        await ctx.db
          .update(conversations)
          .set({ target_workflow_id: targetWorkflowId, updated_at: new Date() })
          .where(eq(conversations.id, ctx.conversation_id));
      }
    }

    let result: Awaited<ReturnType<typeof createWorkflow>>;
    try {
      if (targetWorkflowId) {
        // Update path: keep the existing row's slug authoritative. A
        // changed draft.slug would re-trigger the unique-index on
        // another row if it collided, which is the right behavior.
        result = await updateWorkflow(
          { tenant_id: ctx.tenant_id, id: targetWorkflowId, def, actor_id: ctx.actor_id },
          ctx.db,
        );
      } else {
        result = await createWorkflow(
          { tenant_id: ctx.tenant_id, def, actor_id: ctx.actor_id },
          ctx.db,
        );
      }
    } catch (err) {
      // Postgres raises 23505 on a unique-constraint violation —
      // shouldn't happen on the update path (same-row writes), but the
      // create path can still collide with a concurrent insert. Drizzle
      // wraps the error and the surface message can be
      // `Failed query: ...` with no "duplicate" substring, so check
      // multiple signals.
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
      const code = (err as { code?: string }).code ?? cause?.code;
      const constraint = (err as { constraint?: string }).constraint ?? cause?.constraint ?? "";
      const looksLikeSlugConflict =
        code === "23505" ||
        msg.includes("23505") ||
        msg.toLowerCase().includes("duplicate key") ||
        constraint.includes("workflows_tenant_slug") ||
        constraint.includes("workflows_slug") ||
        msg.includes('insert into "workflows"');
      if (looksLikeSlugConflict) {
        const attempted = def.slug ?? def.name;
        // Look up the offending workflow so the LLM can choose between
        // updating it (call commit_draft again — the adopt path will
        // pick it up) or picking a different slug.
        const conflictRows = await ctx.db
          .select({ id: workflows.id, slug: workflows.slug })
          .from(workflows)
          .where(
            and(
              eq(workflows.tenant_id, ctx.tenant_id),
              eq(workflows.slug, attempted),
              isNull(workflows.deleted_at),
            ),
          )
          .limit(1);
        const existing = conflictRows[0];
        return {
          ok: false,
          data: buildGateError(fullDraft, {
            error_code: "duplicate_slug",
            message: `workflow slug "${attempted}" already exists`,
            recommended_mode: "workflow",
            extra: {
              errors: [
                {
                  path: "slug",
                  message: existing
                    ? `a workflow with slug "${attempted}" already exists (id=${existing.id}) — to update it, call commit_draft again; the save tool will now update this workflow in place. To create a new workflow, pick a different slug.`
                    : `a workflow with slug "${attempted}" already exists for this tenant — pick a different slug and call commit_draft again`,
                },
              ],
              attempted_slug: attempted,
              ...(existing ? { conflict: { workflow_id: existing.id, slug: existing.slug } } : {}),
            },
          }),
        };
      }
      return {
        ok: false,
        data: buildGateError(fullDraft, {
          error_code: "commit_failed",
          message: msg,
          recommended_mode: "workflow",
        }),
      };
    }
    if ("errors" in result) {
      return {
        ok: false,
        data: buildGateError(fullDraft, {
          error_code: "invalid_final_draft",
          message: "workflow draft is still invalid at commit time",
          stale_checkpoints: ["workflow_validated"],
          recommended_mode: "workflow",
          extra: {
            errors: result.errors,
            step_count: def.steps.length,
          },
        }),
      };
    }
    const workflow = result.workflow;
    await ctx.db
      .update(conversations)
      .set({
        target_workflow_id: workflow.id,
        status: "committed",
        updated_at: new Date(),
      })
      .where(eq(conversations.id, ctx.conversation_id));
    const nextDraft = withWorkflowPersisted(
      fullDraft,
      {
        kind: "workflow",
        id: workflow.id,
        slug: workflow.slug,
        name: workflow.name,
        version_id: workflow.current_version_id,
        version: workflow.current_version,
        environment: null,
        saved_at: new Date().toISOString(),
      },
      "workflow_persisted",
    );
    await ctx.setDraft(nextDraft);
    return {
      ok: true,
      data: {
        ...buildPersistencePayload(nextDraft, {
          resource_kind: "workflow",
          resource_id: workflow.id,
          version_id: workflow.current_version_id,
        }),
        workflow_id: workflow.id,
        workflow_version_id: workflow.current_version_id,
        version: workflow.current_version,
        slug: workflow.slug,
        name: workflow.name,
      },
      committed_workflow_id: workflow.id,
    };
  },
};
