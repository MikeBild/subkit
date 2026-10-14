import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActor } from "./types.ts";

export interface RecordExecutionCrashRecoveredParams extends RecorderBase {
  execution_id: string;
  workflow_id: string | null;
  reason: string;
  metadata: Record<string, unknown>;
}

export async function recordExecutionCrashRecovered(
  p: RecordExecutionCrashRecoveredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.EXECUTION_CRASH_RECOVERED,
      resource_type: "execution",
      resource_id: p.execution_id,
      result: "success",
      reason: p.reason,
      metadata: {
        ...p.metadata,
        ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
      },
    },
    p.executor,
  );
}
