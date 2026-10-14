import type { executions } from "../db/schema/index.ts";
import { describeExecutionCaller } from "./caller-summary.ts";
import { matchingWorkflowPermission } from "./workflow-permission.ts";

type EvidenceRow = Pick<
  typeof executions.$inferSelect,
  | "id"
  | "tenant_id"
  | "workflow_id"
  | "execution_mode"
  | "execution_authority_id"
  | "caller_context"
  | "caller_origin"
  | "authorization_context"
  | "request_source"
  | "authority_root_execution_id"
>;

export function describeExecutionEvidence(row: EvidenceRow) {
  const permission =
    row.caller_context?.tenantId === row.tenant_id
      ? matchingWorkflowPermission(
          row.authorization_context?.workflow_permission,
          row.caller_context,
          row.workflow_id,
        )
      : null;
  return {
    caller: describeExecutionCaller(row),
    execution_environment: row.execution_mode,
    execution_authority_id: row.execution_authority_id ?? null,
    permission_basis: permission?.source ?? null,
    permission_phase: permission?.phase ?? null,
    permission_checked_at: permission?.checked_at ?? null,
  };
}
