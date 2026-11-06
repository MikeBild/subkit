import { runExecution } from "../../../execution/engine.ts";
import { approvedDispatchOutcome } from "../../../execution/tool-approval-dispatch.ts";
import { authorizeWorkflowRun } from "../../../execution/use-cases/run-workflow.ts";
import {
  approvalAuditResource,
  recordApprovalApproved,
  recordApprovalUnfulfilled,
} from "../../../tools/approval.ts";
import { preparedWorkflowMatches } from "../../../tools/prepared-workflow-approval.ts";
import { resolveWorkflowByIdOrSlug } from "../../../workflows/lookup.ts";
import { heldTargetMissing, heldWorkflowSlug, replayInput } from "../../core/auto-persist.ts";
import { WORKFLOW_TOOL_PREFIX } from "../../tools/authoring-palette.ts";
import type { ToolResult } from "../../tools/index.ts";
import { grantAndClaim } from "./approval.ts";
import { invalidIntent, permissionDenied, principalRequired } from "./context.ts";
import { readString } from "./helpers.ts";
import type { CommitEnv } from "./types.ts";

export async function commitHeldWorkflowWrites(
  { p, intent }: CommitEnv,
  toolName: string,
): Promise<ToolResult> {
  const approvalId = readString(intent.payload, "approval_id");
  if (!approvalId) {
    return invalidIntent(
      "commit_held_workflow_writes commit_intent is missing payload.approval_id — nothing was written.",
    );
  }
  if (!p.principal) {
    return principalRequired(
      "releasing held workflow writes needs the approving actor's principal for RBAC — nothing was written.",
      {},
    );
  }
  const claim = await grantAndClaim(p, approvalId, toolName, p.principal);
  if (!claim.ok) return { ok: false, error_code: claim.code, message: claim.message, data: {} };
  const approvedTool = claim.tool;
  const workflowSlug = heldWorkflowSlug(approvedTool, WORKFLOW_TOOL_PREFIX);
  const resolved = workflowSlug
    ? await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, workflowSlug, {
        require_published: true,
      })
    : null;
  if (!resolved) {
    const missing = heldTargetMissing(workflowSlug, claim.approval_id, approvedTool);
    await recordApprovalUnfulfilled({
      db: p.db,
      principal: p.principal,
      claim,
      tool: approvedTool,
      via: "chat",
      reason: missing.reason,
    });
    return missing.result;
  }
  const workflowId = resolved.id;
  const binding = claim.prepared_workflow;
  if (
    !preparedWorkflowMatches(binding, {
      workflow_id: workflowId,
      workflow_version_id: resolved.current_version_id,
      execution_mode: claim.execution_mode,
      args: claim.args,
    })
  ) {
    await recordApprovalUnfulfilled({
      db: p.db,
      principal: p.principal,
      claim,
      tool: approvedTool,
      via: "chat",
      reason: "prepared_workflow_changed",
    });
    return {
      ok: false,
      error_code: "prepared_workflow_changed",
      message:
        "The reviewed workflow version or input is missing or changed. Create a fresh preview and obtain a new decision; nothing was written by this attempt.",
      data: { workflow_id: workflowId },
    };
  }
  const grant = await authorizeWorkflowRun(
    {
      principal: p.principal,
      workflow_id: workflowId,
      workflow_slug: resolved.slug,
      via: "auto_persist",
      tool: approvedTool,
      approval: approvalAuditResource(claim),
    },
    { db: p.db },
  );
  if (grant.kind === "rejected") return permissionDenied(grant.message, workflowId);
  const recorded = await recordApprovalApproved({
    db: p.db,
    principal: p.principal,
    claim,
    tool: approvedTool,
    via: "chat",
  });
  if (!recorded) {
    return {
      ok: false,
      error_code: "approval_audit_failed",
      message: `Approval ${claim.approval_id} could not be recorded in the audit log; ${approvedTool} did not run. Re-issue ${approvedTool} to obtain a fresh preview.`,
      data: { workflow_id: workflowId },
    };
  }
  const heldRun = await runExecution({
    db: p.db,
    tenant_id: p.tenant_id,
    source: {
      kind: "saved",
      workflow_id: workflowId,
      version_id: binding.workflow_version_id,
    },
    input: replayInput(claim.args),
    options: {
      request_source: "chat",
      trace_id: null,
      principal: p.principal,
      execution_mode: claim.execution_mode ?? "dev",
      self_healing: { enabled: false },
      tool_approval_id: claim.approval_id,
    },
  });
  return {
    ok: heldRun.status === "succeeded",
    data: {
      status: heldRun.status,
      execution_id: heldRun.execution_id,
      workflow_id: workflowId,
      workflow_slug: resolved.slug,
      output: heldRun.output,
      ...(await approvedDispatchOutcome(p.db, p.tenant_id, heldRun.execution_id)),
      ...(heldRun.warnings && heldRun.warnings.length > 0 ? { warnings: heldRun.warnings } : {}),
    },
  };
}
