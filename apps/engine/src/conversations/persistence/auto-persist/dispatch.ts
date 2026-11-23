import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { auditAwait } from "../../../audit/audit.ts";
import { resolveActor } from "../../../audit/recorders/types.ts";
import { AuditAction } from "../../../audit/types.ts";
import { listResolvedConnectorTemplates } from "../../../connectors/template-resolver.ts";
import { conversations } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/index.ts";
import { listWorkflowsUsingConnector } from "../../../workflows/connector-refs.ts";
import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import type { ToolContext, ToolResult } from "../../tools/index.ts";
import { inspectConnectorDraftTool } from "../../tools/inspect-connector-draft.ts";
import { probeConnectorDraftTool } from "../../tools/probe-connector-draft.ts";
import { validateConnectorDraftTool } from "../../tools/validate-connector-draft.ts";
import { readString } from "./helpers.ts";

export async function maybeAutoFreshenCheckpointsForSave(ctx: ToolContext): Promise<void> {
  try {
    const draft = ctx.getDraft();
    if (!draft.connector) return;
    await inspectConnectorDraftTool.execute(ctx, {});
    await validateConnectorDraftTool.execute(ctx, {});
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "auto_freshen_checkpoints_failed",
      msg: "auto-inspect/validate before save failed — falling through to saveConnectorAtomic which will surface the gate error",
      conversation_id: ctx.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function maybeAutoProbeForSave(ctx: ToolContext, tenant_id: string): Promise<void> {
  try {
    const draft = ctx.getDraft();
    const connector = draft.connector;
    if (!connector) return;
    const requiresProbe =
      connector.driver === "http" ||
      connector.driver === "graphql" ||
      connector.driver === "postgres" ||
      connector.driver === "s3" ||
      connector.driver === "sftp";
    if (!requiresProbe) return;
    if (connector.latest_probe?.ok === true) return;
    if (!connector.template_slug) return;
    const templates = await listResolvedConnectorTemplates(ctx.db, tenant_id);
    const template = templates.find((t) => t.template.slug === connector.template_slug)?.template;
    const probeEndpoint = template?.probe_endpoint;
    if (!probeEndpoint) return;
    await probeConnectorDraftTool.execute(ctx, {
      method: probeEndpoint.method,
      path: probeEndpoint.path === "" ? "/" : probeEndpoint.path,
    });
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "auto_probe_failed",
      msg: "auto-probe before save failed — falling through to saveConnectorAtomic which will surface probe_failed",
      tenant_id,
      conversation_id: ctx.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const DeleteConnectorPayloadSchema = z
  .object({
    id: z.string().uuid(),
    confirm_orphan: z.boolean().optional(),
  })
  .passthrough();

export async function dispatchDeleteConnector(
  ctx: ToolContext,
  intent: CommitIntent,
): Promise<ToolResult> {
  const parsedPayload = DeleteConnectorPayloadSchema.safeParse(intent.payload);
  if (!parsedPayload.success) {
    return {
      ok: false,
      error_code: "invalid_payload",
      message: "delete_connector commit_intent requires payload.id (a connector uuid)",
      next_best_actions: ["ask_user"],
    };
  }
  const id = parsedPayload.data.id;
  const dependents = await listWorkflowsUsingConnector(ctx.tenant_id, id, ctx.db);
  const confirmedOrphan = parsedPayload.data.confirm_orphan === true;
  if (dependents.length > 0 && !confirmedOrphan) {
    logger.info({
      module: "auto-persist",
      action: "delete_connector.has_dependents",
      msg: "refused connector delete — live workflows still bind this connector",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      connector_id: id,
      dependent_count: dependents.length,
      dependent_workflow_ids: dependents.map((w) => w.id),
    });
    const dependentSlugs = dependents.map((w) => w.slug).join(", ");
    const plural = dependents.length === 1 ? "" : "s";
    return {
      ok: false,
      error_code: "connector_has_dependents",
      message: `connector ${id} is used by ${dependents.length} live workflow${plural} (${dependentSlugs}). Edit those workflows off this connector first, or re-confirm the delete with confirm_orphan: true after the operator accepts that the workflows will break.`,
      data: { dependents },
      next_best_actions: ["edit_workflow_patch", "delete_workflow"],
    };
  }
  const ok =
    confirmedOrphan && dependents.length > 0
      ? await ctx.engineClient.connectors.delete(id, {
          orphaned_workflow_ids: dependents.map((w) => w.id),
        })
      : await ctx.engineClient.connectors.delete(id);
  if (!ok) {
    return {
      ok: false,
      error_code: "connector_not_found",
      message: `connector ${id} does not exist or was already deleted`,
      next_best_actions: ["cannot_help"],
    };
  }
  await ctx.db
    .update(conversations)
    .set({ target_connector_id: null, updated_at: new Date() })
    .where(eq(conversations.id, ctx.conversation_id));
  return {
    ok: true,
    data: { id, deleted: true, kind: "connector" },
  };
}

export async function dispatchDeleteWorkflow(
  ctx: ToolContext,
  intent: CommitIntent,
): Promise<ToolResult> {
  const id = readString(intent.payload, "id");
  if (!id) {
    return {
      ok: false,
      error_code: "invalid_payload",
      message: "delete_workflow commit_intent requires payload.id",
      next_best_actions: ["ask_user"],
    };
  }
  const ok = await ctx.engineClient.workflows.delete(id);
  if (!ok) {
    return {
      ok: false,
      error_code: "workflow_not_found",
      message: `workflow ${id} does not exist or was already deleted`,
      next_best_actions: ["cannot_help"],
    };
  }
  await ctx.db
    .update(conversations)
    .set({ target_workflow_id: null, updated_at: new Date() })
    .where(eq(conversations.id, ctx.conversation_id));
  return {
    ok: true,
    data: { id, deleted: true, kind: "workflow" },
  };
}

export async function dispatchRollbackSkipped(
  ctx: ToolContext,
  intent: CommitIntent,
): Promise<ToolResult> {
  const execution_id = readString(intent.payload, "execution_id");
  await auditAwait(
    {
      tenant_id: ctx.tenant_id,
      ...resolveActor({
        tenant_id: ctx.tenant_id,
        actor_id: ctx.engineClient.context.actor_id,
        actor_type:
          ctx.engineClient.context.actor_type ?? (ctx.actor_id === null ? "system" : "unknown"),
      }),
      action: AuditAction.EXECUTION_ABORTED,
      resource_type: "execution",
      resource_id: execution_id ?? null,
      result: "denied",
      reason: "not_implemented",
      metadata: {
        source: "harness_auto_persist",
        commit_intent_kind: "rollback_after_execute",
        skipped: true,
      },
    },
    ctx.db,
  );
  return {
    ok: false,
    error_code: "not_implemented",
    message:
      "rollback_after_execute is not implemented yet — the harness recorded an audit_log.rollback.skipped row with reason=not_implemented",
    next_best_actions: ["cannot_help"],
    data: {
      kind: "rollback_after_execute",
      skipped: true,
      reason: "not_implemented",
      ...(execution_id ? { execution_id } : {}),
    },
  };
}
