// Per-kind dispatchers (delete_connector, delete_workflow,
// rollback_after_execute) + the auto-freshen / auto-probe steps that
// run before save_connector_draft to absorb missing checkpoints. The
// save_connector_draft / save_workflow_draft paths run inline in the
// orchestrator entry because they share local state with the audit
// row.

import { eq } from "drizzle-orm";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { listResolvedConnectorTemplates } from "../../../connectors/template-resolver.ts";
import { conversations } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/logger.ts";
import { listWorkflowsUsingConnector } from "../../../workflows/connector-dependents.ts";
import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import type { ToolContext, ToolResult } from "../../tools/index.ts";
import { inspectConnectorDraftTool } from "../../tools/inspect-connector-draft.ts";
import { probeConnectorDraftTool } from "../../tools/probe-connector-draft.ts";
import { validateConnectorDraftTool } from "../../tools/validate-connector-draft.ts";
import { readString } from "./helpers.ts";

/**
 * Refresh the `connector_inspected` and `connector_validated`
 * checkpoints before save. Both are pure draft-side computations that
 * stamp readiness onto the AuthoringState; the LLM is supposed to call
 * them between proposing the connector and asking for save approval,
 * but in practice it routinely skips one or both — we saw this in
 * session 16a8f1c7 where the model went probe → ask_user_confirm and
 * the auto-persist path bounced off `connector_not_ready` because
 * `connector_validated` was still missing. The user then had to
 * approve a SECOND time after the model retried through the
 * tool-policy gate.
 *
 * The harness already auto-probes here; auto-inspect+auto-validate is
 * the same idea: the operator's "yes save" click is the authority,
 * and the engine should make sure it can act on it instead of
 * deferring to LLM-discipline checkpoints.
 *
 * No-op when there is no connector draft. Failures fall through; the
 * subsequent `saveConnectorAtomic` will surface the canonical
 * structured error.
 */
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

/**
 * Auto-probe a draft connector before the auto-persist save runs.
 *
 * Reads the draft's resolved template; when the template declares a
 * `probe_endpoint` and the draft is in the pre-probe state, dispatches
 * the existing `probe_connector_draft` tool with the template's method
 * + path. The credential cache populated by
 * `maybeCacheDraftCredentialFromElicitation` is what authenticates the
 * probe — so this only fires for the form-submit-then-save bundle.
 *
 * No-op when the connector is missing, has no template_slug, the
 * template has no probe_endpoint, the latest probe already passed, or
 * any failure is encountered (the save will surface
 * `probe_failed`/`connector_not_ready` itself).
 */
export async function maybeAutoProbeForSave(ctx: ToolContext, tenant_id: string): Promise<void> {
  try {
    const draft = ctx.getDraft();
    const connector = draft.connector;
    if (!connector) return;
    const requiresProbe =
      connector.driver === "http" ||
      connector.driver === "graphql" ||
      connector.driver === "postgres" ||
      connector.driver === "s3";
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

export async function dispatchDeleteConnector(
  ctx: ToolContext,
  intent: CommitIntent,
): Promise<ToolResult> {
  const id = readString(intent.payload, "id");
  if (!id) {
    return {
      ok: false,
      error_code: "invalid_payload",
      message: "delete_connector commit_intent requires payload.id",
      next_best_actions: ["ask_user"],
    };
  }
  // Dependency backstop: deleting a connector that a live workflow's
  // step binds to breaks that workflow at its next run. Refuse the
  // delete and surface the dependents unless the operator explicitly
  // acknowledged the orphaning via `payload.confirm_orphan === true`.
  const dependents = await listWorkflowsUsingConnector(ctx.tenant_id, id, ctx.db);
  const confirmedOrphan = intent.payload?.confirm_orphan === true;
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
  // An acknowledged-orphaning delete (confirm_orphan over live dependents)
  // threads the dependent ids so the CONNECTOR_DELETED audit row records that
  // the operator proceeded despite the warning.
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
  // Audit the skipped rollback so operators can see the no-op trail.
  await auditAwait(
    {
      tenant_id: ctx.tenant_id,
      actor_type: ctx.actor_id ? "user" : "system",
      actor_id: ctx.actor_id,
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
