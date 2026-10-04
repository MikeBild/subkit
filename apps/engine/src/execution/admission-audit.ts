import { AuditAction, type AuditActorType, auditAwait, sanitizeForAudit } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import { logger } from "../logging/logger.ts";

export interface AdmissionRefusal {
  tenant_id: string;
  reason: string;
  message?: string | null;
  workflow_id?: string | null;
  execution_id?: string | null;
  request_source: string;
  actor_id?: string | null;
  actor_type?: AuditActorType;
  extra?: Record<string, unknown>;
}

export async function auditAdmissionRefusal(input: AdmissionRefusal, db: Executor): Promise<void> {
  try {
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_type ?? "system",
        actor_id: input.actor_id ?? null,
        action: AuditAction.EXECUTION_BOUNDARY_REFUSED,
        resource_type: input.execution_id ? "execution" : "workflow",
        resource_id: input.execution_id ?? input.workflow_id ?? input.tenant_id,
        result: "denied",
        reason: input.reason,
        metadata: {
          stage: "admission",
          request_source: input.request_source,
          ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
          ...(input.message ? { detail: sanitizeForAudit(String(input.message), 500) } : {}),
          ...(input.extra ?? {}),
        },
      },
      db,
    );
  } catch (error) {
    logger.error({
      module: "execution",
      action: "execution.boundary_refused.unrecorded",
      msg: "admission refused but the audit row could not be written",
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id ?? null,
      execution_id: input.execution_id ?? null,
      request_source: input.request_source,
      refusal_reason: input.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
