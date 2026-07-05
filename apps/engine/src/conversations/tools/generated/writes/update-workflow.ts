// update_workflow — patch a persisted workflow's metadata (slug,
// display name, description, lifecycle) without rewriting the dag or
// version history. Generic on purpose: the LLM picks which subset of
// fields to send, the same tool covers rename, re-describe, archive,
// and reactivate.
//
// `description` writes the editable `workflows.description` column —
// the canonical source for the LLM-facing `wf_<slug>` tool description
// (catalog precedence: column → DAG → name). It is metadata: setting it
// does NOT roll a new version. Sending an empty string clears it.
//
// Subkit's chat-first contract requires rename + lifecycle ops to be
// reachable as a chat tool, not only as HTTP datastore ops — collapsing
// rename and lifecycle into one generic patch (one tool, several fields).
//
// Audit shape uses the existing WORKFLOW_UPDATED action with
// `metadata.kind: "metadata"` plus before/after snapshots — never a
// new action enum entry, since it's still a workflow.updated event.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { conversations } from "../../../../db/schema/index.ts";
import { bindPersistedWorkflow } from "../../../authoring-state.ts";
// Import from the leaf module, not the auto-persist barrel: the barrel
// (auto-persist.ts) imports this tool for the update_workflow_metadata
// commit_intent dispatch, so pulling the barrel here would form a cycle.
import { translateAutoPersistError } from "../../../persistence/auto-persist/error-translation.ts";
import { classifyDraftVsPersisted } from "../../../persistence/draft-diff.ts";
import type { ConversationTool } from "../../index.ts";

const UpdateWorkflowInput = z
  .object({
    id: z.string().uuid("workflow id must be a UUID"),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric with hyphens")
      .optional(),
    name: z.string().min(1).optional(),
    description: z
      .string()
      .max(2000)
      .optional()
      .describe(
        "One-paragraph workflow description. Becomes the LLM-facing wf_<slug> tool description. Send an empty string to clear it. Metadata only — does not roll a new version.",
      ),
    lifecycle: z.enum(["active", "archived"]).optional(),
  })
  .refine(
    (v) =>
      v.slug !== undefined ||
      v.name !== undefined ||
      v.description !== undefined ||
      v.lifecycle !== undefined,
    {
      message: "At least one of slug, name, description, or lifecycle is required",
    },
  )
  .openapi("UpdateWorkflowToolInput");

export const updateWorkflowTool: ConversationTool = {
  name: "update_workflow",
  description:
    "Patch a persisted workflow's metadata (slug, display name, description, lifecycle) without rewriting the dag or version history.",
  // NOT `requires_persisted_workflow`: like delete_workflow this targets an
  // EXISTING workflow by an explicit id supplied in the args, is only called on
  // explicit management intent ("rename/archive workflow X"), and has no
  // no-args loop failure mode. Flagging it made the step-router hide it on a
  // fresh conversation, so those requests silently failed. See step-router.ts.
  use_case:
    "Use when the user asks to rename a workflow, set or change its description, archive it, or reactivate it. Send only the fields that should change. Does NOT alter steps, input/output schema, or version count — for those, edit the draft and use save_workflow_draft.",
  important_notes: [
    "At least one of slug, name, description, or lifecycle is required.",
    "description sets the editable workflows.description column — the LLM-facing wf_<slug> tool description. Metadata only: it does NOT roll a new version. Send an empty string to clear it.",
    "slug must be lowercase alphanumeric with hyphens; the service slugifies it again before the write.",
    "Slug uniqueness is enforced; collisions return slug_conflict_with_live_workflow with conflict.workflow_id.",
    "Audits as workflow.updated with metadata.kind='metadata' plus from/to snapshots — never overrides version history.",
    "lifecycle accepts 'active' or 'archived'. 'draft' cannot be set explicitly; that is a status the create flow assigns.",
  ],
  inputSchema: UpdateWorkflowInput,
  category: "tenant_write",
  permission: { action: "workflow:write", resourceType: "workflow", resourceIdArg: "id" },
  async execute(ctx, rawArgs) {
    const args = UpdateWorkflowInput.parse(rawArgs);
    // Anti silent step-loss (B3): update_workflow writes METADATA only
    // (slug/name/description/lifecycle) and rolls no version. If the
    // conversation's working draft has uncommitted STEP edits for THIS workflow,
    // persisting metadata here leaves those edits unsaved while the model reports
    // success — the wrong-verb trap behind the render-upload-slides incident.
    // Refuse and point at the durable step path; metadata-only / clean / unbound
    // drafts proceed. classifyDraftVsPersisted is read-only and resolves any
    // ambiguity to "no_target", so this never blocks a legitimate metadata edit.
    const draftState = await classifyDraftVsPersisted(
      ctx.db,
      ctx.tenant_id,
      ctx.getDraft(),
      args.id,
    );
    if (draftState.state === "structural") {
      return {
        ok: false as const,
        data: {
          error: "uncommitted_step_edits",
          message:
            "This conversation's draft has uncommitted step edits for this workflow. update_workflow changes metadata only (name/slug/description/lifecycle) and would NOT persist those step changes. Commit the step edits first with save_workflow_draft (after a successful dry_run_workflow), then call update_workflow for any metadata change.",
          next_best_actions: ["dry_run_workflow", "save_workflow_draft"],
        },
      };
    }

    let result: Awaited<ReturnType<typeof ctx.engineClient.workflows.update>>;
    try {
      result = await ctx.engineClient.workflows.update({
        id: args.id,
        ...(args.slug !== undefined ? { slug: args.slug } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.lifecycle !== undefined ? { lifecycle: args.lifecycle } : {}),
      });
    } catch (err) {
      // Translate Postgres errors so the LLM gets `slug_already_in_use`
      // / `in_use_by_dependent_rows` / `missing_required_field`
      // instead of a raw SQL string. Mirrors save-connector-draft.ts
      // and the auto-persist dispatcher.
      const translated = translateAutoPersistError(err, "save_workflow_draft");
      return {
        ok: false,
        data: {
          error: translated.error_code,
          message: translated.message,
          next_best_actions: translated.next_best_actions,
        },
      };
    }

    if (result.errors) {
      if (result.conflict) {
        return {
          ok: false,
          data: {
            error: "slug_conflict_with_live_workflow",
            attempted_slug: args.slug,
            conflict: result.conflict,
            recovery: {
              pick_different_slug:
                "Call update_workflow again with a different slug, or update the colliding workflow first.",
            },
            errors: result.errors,
          },
        };
      }
      const isNotFound = result.errors.some((e) => /not found/i.test(e));
      return {
        ok: false,
        data: {
          error: isNotFound ? "workflow_not_found" : "update_failed",
          errors: result.errors,
        },
      };
    }

    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "workflow",
      resource_id: result.workflow.id,
      action: "conversation.update_workflow",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        slug: args.slug,
        name: args.name,
        description: args.description,
        lifecycle: args.lifecycle,
      },
    });
    await ctx.db
      .update(conversations)
      .set({
        target_workflow_id: result.workflow.id,
        updated_at: new Date(),
      })
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      );
    await ctx.setDraft(
      bindPersistedWorkflow(ctx.getDraft(), {
        kind: "workflow",
        id: result.workflow.id,
        slug: result.workflow.slug,
        name: result.workflow.name,
        version_id: result.workflow.current_version_id,
        version: result.workflow.current_version,
        environment: null,
        saved_at: result.workflow.updated_at.toISOString(),
      }),
    );

    return {
      ok: true,
      data: {
        updated: true,
        workflow: {
          id: result.workflow.id,
          slug: result.workflow.slug,
          name: result.workflow.name,
          description: result.workflow.description,
          lifecycle: result.workflow.lifecycle,
        },
        audit_log_id,
      },
    };
  },
};
