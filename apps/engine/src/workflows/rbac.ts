// Shared RBAC gate for `workflow:run` dispatches.
//
// Three execution surfaces dispatch saved workflows:
//   1. MCP `wf_<slug>` (apps/engine/src/mcp/capabilities/tools.ts).
//   2. Conversation fast-path "run <slug>" branch + affirmation-resume
//      (apps/engine/src/conversations/fast-path.ts).
//   3. Conversation synthetic `wf_<slug>` palette
//      (apps/engine/src/conversations/tools/sdk-wrap/synthetic-workflow-tools.ts).
//   4. The fallback `run_workflow` conversation tool
//      (apps/engine/src/conversations/tools/generated/writes/run-workflow.ts).
//
// They must agree on the RBAC decision and on the POLICY_DENIED audit
// row on refusal. This helper extracts the canonical block from MCP's
// `tools.ts` so the four surfaces cannot drift.

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import { can } from "../rbac/evaluator.ts";
import type { ApprovalAuditResource } from "../tools/approval.ts";

export type WorkflowRunRequestSource = "mcp" | "chat" | "fast_path" | "auto_persist";

export interface GateWorkflowRunRbacParams {
  db: Db;
  principal: ResolvedPrincipal;
  workflow_id: string;
  request_source: WorkflowRunRequestSource;
  /**
   * Optional tool name for the audit metadata. MCP passes `wf_<slug>`;
   * chat/fast-path pass `run_workflow` (or the synthetic dispatch name).
   * Falls back to `request_source` when omitted.
   */
  tool?: string;
  /**
   * Optional workflow slug for the audit row. Denormalised here so
   * operator dashboards aggregating denials per workflow don't need
   * a join — the `resource_id` already carries the workflow_id, but a
   * SIEM filter is easier on a human-readable slug. Pass when known;
   * omit otherwise.
   */
  workflow_slug?: string;
  /**
   * Set when this dispatch is the confirmed replay of an approval whose
   * single-use handle is already burned. The POLICY_DENIED row then anchors on
   * the approval lifecycle instead of the workflow, so "approval opened →
   * confirmed replay denied" is one JOIN rather than two unrelated rows. The
   * workflow stays reachable through `metadata.workflow_id`.
   */
  approval?: ApprovalAuditResource;
}

export type WorkflowRunRbacDecision =
  { allow: true } | { allow: false; reason: string; error_message: string };

/**
 * Evaluate `workflow:run` on the given workflow and write a
 * POLICY_DENIED audit row on refusal. On allow, returns `{ allow: true }`
 * and writes nothing — the caller still runs whatever execution audit
 * follows. On refusal, the audit row is committed before the function
 * returns so callers can surface the deny synchronously without racing
 * the fire-and-forget audit pipeline.
 */
export async function gateWorkflowRunRbac(
  p: GateWorkflowRunRbacParams,
): Promise<WorkflowRunRbacDecision> {
  const decision = await can(p.db, {
    tenant_id: p.principal.tenant_id,
    principal: p.principal,
    permission: "workflow:run",
    resource: { type: "workflow", id: p.workflow_id },
  });
  if (decision.allow) return { allow: true };

  // Surface-neutral reason names — the canonical RBAC contract is the
  // same regardless of which call site (mcp / chat / fast_path) hit
  // the gate. Operators filtering audit by `reason` get one bucket per
  // failure mode instead of one bucket per surface.
  const allowlistViolation =
    p.principal.provider === "portal_token" || Array.isArray(p.principal.allowed_workflows);
  const auditReason = allowlistViolation
    ? "workflow_not_in_allowlist"
    : (decision.reason ?? "workflow_run_permission_denied");
  const errMessage = allowlistViolation
    ? "workflow_not_in_allowlist"
    : (decision.reason ?? "permission_denied");

  await auditAwait(
    {
      tenant_id: p.principal.tenant_id,
      actor_type: p.principal.kind === "user" ? "user" : "system",
      actor_id: p.principal.id,
      action: AuditAction.POLICY_DENIED,
      resource_type: p.approval?.resource_type ?? "workflow",
      resource_id: p.approval?.approval_id ?? p.workflow_id,
      result: "denied",
      reason: auditReason,
      metadata: {
        tool: p.tool ?? p.request_source,
        via: p.request_source,
        provider: p.principal.provider,
        permission: "workflow:run",
        workflow_id: p.workflow_id,
        ...(p.approval ? { approval_id: p.approval.approval_id } : {}),
        ...(p.workflow_slug ? { workflow_slug: p.workflow_slug } : {}),
      },
    },
    p.db,
  );
  logger.warn({
    module: "rbac",
    action: "workflow_run.denied",
    msg: "workflow:run denied by RBAC evaluator",
    request_source: p.request_source,
    tool: p.tool ?? p.request_source,
    workflow_id: p.workflow_id,
    principal_id: p.principal.id,
    reason: decision.reason,
  });
  return { allow: false, reason: auditReason, error_message: errMessage };
}
