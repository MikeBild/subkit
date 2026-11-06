import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { captureWorkflowPermission, type WorkflowPermission } from "../execution/index.ts";
import { logger } from "../logging/logger.ts";
import { can } from "../rbac/evaluator.ts";
import type { ApprovalAuditResource } from "../tools/approval.ts";

export type WorkflowRunRequestSource = "mcp" | "chat" | "fast_path" | "auto_persist";

interface GateWorkflowRunRbacParams {
  db: Db;
  principal: ResolvedPrincipal;
  workflow_id: string;
  request_source: WorkflowRunRequestSource;
  tool?: string;
  workflow_slug?: string;
  approval?: ApprovalAuditResource;
}

type WorkflowRunRbacDecision =
  | { allow: true; workflow_permission: WorkflowPermission | null }
  | { allow: false; reason: string; error_message: string };

export async function gateWorkflowRunRbac(
  p: GateWorkflowRunRbacParams,
): Promise<WorkflowRunRbacDecision> {
  const decision = await can(p.db, {
    tenant_id: p.principal.tenant_id,
    principal: p.principal,
    permission: "workflow:run",
    resource: { type: "workflow", id: p.workflow_id },
  });
  if (decision.allow)
    return {
      allow: true,
      workflow_permission: await captureWorkflowPermission(
        p.db,
        p.principal,
        p.workflow_id,
        decision,
      ),
    };

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
      actor_type: p.principal.kind,
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
