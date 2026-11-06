import { z } from "@hono/zod-openapi";
import { bindPersistedWorkflow } from "../../../authoring-state/index.ts";
import { translateAutoPersistError } from "../../../persistence/auto-persist/error-translation.ts";
import { classifyDraftVsPersisted } from "../../../persistence/draft-diff.ts";
import { setConversationWorkflowTarget } from "../../../service/tool-state.ts";
import type { ConversationTool } from "../../index.ts";

export const UpdateWorkflowInput = z
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
  async execute(ctx, args: z.infer<typeof UpdateWorkflowInput>) {
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
    await setConversationWorkflowTarget(ctx.db, ctx, result.workflow.id);
    await ctx.setDraft(
      bindPersistedWorkflow(
        ctx.getDraft(),
        {
          kind: "workflow",
          id: result.workflow.id,
          slug: result.workflow.slug,
          name: result.workflow.name,
          version_id: result.workflow.current_version_id,
          version: result.workflow.current_version,
          environment: null,
          saved_at: result.workflow.updated_at.toISOString(),
        },
        { tool_name: "update_workflow" },
      ),
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
