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
// Reference parity: the reference codebase exposes rename + lifecycle
// only as HTTP datastore ops (`POST /tools/:toolId/rename`,
// /lifecycle endpoints). Subkit's chat-first contract requires the
// same op be reachable as a chat tool — collapsing rename and
// lifecycle into one generic patch matches the reference's
// `edit_tool` shape (one tool, several fields).
//
// Audit shape uses the existing WORKFLOW_UPDATED action with
// `metadata.kind: "metadata"` plus before/after snapshots — never a
// new action enum entry, since it's still a workflow.updated event.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import { conversations, roles, systemAccounts, users } from "../../../../db/schema/index.ts";
import { can } from "../../../../rbac/evaluator.ts";
import { bindPersistedWorkflow } from "../../../authoring-state.ts";
import { translateAutoPersistError } from "../../../persistence/auto-persist.ts";
import type { ConversationTool, ToolContext } from "../../index.ts";

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

type PermissionResult = { allow: true } | { allow: false; reason: string };

async function resolveConversationPrincipal(ctx: ToolContext): Promise<ResolvedPrincipal | null> {
  const actorId = ctx.engineClient.context.actor_id;
  const actorType = ctx.engineClient.context.actor_type;
  if (!actorId || actorType === "system") return null;

  if (actorType === "user") {
    const rows = await ctx.db
      .select({ role: users.role, role_id: users.role_id })
      .from(users)
      .where(and(eq(users.id, actorId), eq(users.tenant_id, ctx.tenant_id)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let roleNames: string[] = [row.role];
    if (row.role_id) {
      // tenant-filter:exempt — RBAC catalog walk by role_id; handles both global rows (tenant_id IS NULL) and tenant rows
      const named = await ctx.db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, row.role_id))
        .limit(1);
      if (named[0]?.name) roleNames = [named[0].name];
    }
    return {
      provider: "conversation_tool",
      kind: "user",
      id: actorId,
      tenant_id: ctx.tenant_id,
      roles: roleNames,
    };
  }
  if (actorType === "system_account") {
    const rows = await ctx.db
      .select({ role_id: systemAccounts.role_id })
      .from(systemAccounts)
      .where(and(eq(systemAccounts.id, actorId), eq(systemAccounts.tenant_id, ctx.tenant_id)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let roleNames: string[] = ["member"];
    if (row.role_id) {
      // tenant-filter:exempt — RBAC catalog walk by role_id; handles both global rows (tenant_id IS NULL) and tenant rows
      const named = await ctx.db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, row.role_id))
        .limit(1);
      if (named[0]?.name) roleNames = [named[0].name];
    }
    return {
      provider: "conversation_tool",
      kind: "system_account",
      id: actorId,
      tenant_id: ctx.tenant_id,
      roles: roleNames,
    };
  }
  return null;
}

async function requirePermission(
  ctx: ToolContext,
  permission: string,
  resource: { type: string; id: string },
): Promise<PermissionResult> {
  const principal = await resolveConversationPrincipal(ctx);
  if (!principal) return { allow: true };
  const decision = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal,
    permission,
    resource,
  });
  if (decision.allow) return { allow: true };
  return { allow: false, reason: decision.reason ?? `permission_denied:${permission}` };
}

function permissionDenied(permission: string, reason: string) {
  return {
    ok: false as const,
    data: { error: "permission_denied", permission, reason },
  };
}

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
  async execute(ctx, rawArgs) {
    const args = UpdateWorkflowInput.parse(rawArgs);
    const auth = await requirePermission(ctx, "workflow:write", {
      type: "workflow",
      id: args.id,
    });
    if (!auth.allow) return permissionDenied("workflow:write", auth.reason);

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
