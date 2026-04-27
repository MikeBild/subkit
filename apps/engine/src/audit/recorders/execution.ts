// Execution audit recorders.
//
// The crash-recovery recorder is fired once per row that the boot-time
// `recoverCrashedExecutions` reaper transitions out of `running` into
// `timed_out`. It exists so compliance tooling can spot crashes by
// scanning `audit_log` (rather than reading runtime structured logs)
// and so the operator gets a non-null `reason` + actor metadata for
// the forced state change.

import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordExecutionCrashRecoveredParams extends RecorderBase {
  execution_id: string;
  workflow_id: string | null;
  /** Always present — `auditAwait` requires a non-null reason. */
  reason: string;
  metadata: Record<string, unknown>;
}

/**
 * Audit a `running` → `timed_out` transition forced by the engine
 * boot-time crash recovery sweep. The metadata MUST carry the timing
 * context (`started_at`, `recovered_at`, `timeout_ms`,
 * `actor_type: "system"`) so an operator triaging the audit row has
 * everything they need without joining back to the executions table.
 */
export async function recordExecutionCrashRecovered(
  p: RecordExecutionCrashRecoveredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      // Crash recovery runs without a logged-in actor; default to
      // "system" unless the caller explicitly threads a different
      // actor_type through (e.g. an admin-triggered manual reaper).
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
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
