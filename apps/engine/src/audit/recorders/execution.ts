// Execution audit recorders.
//
// The crash-recovery recorder is fired once per execution whose state is
// repaired by `recoverCrashedExecutions`: either the execution itself is
// terminalized, or stale running step rows are reconciled from an already
// terminal parent. It exists so compliance tooling can spot crash residue by
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
 * Audit an execution/step state repair forced by the engine crash-recovery
 * sweep. Metadata carries the transition's timing and classification context
 * so an operator can triage the repair without joining runtime logs.
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
