// A run that was never allowed to start leaves the same kind of mark as one
// that was stopped mid-flight.
//
// Two layers can refuse: the dispatcher, once a step is running and about to
// reach a remote system, and admission, before anything runs at all. Only the
// first wrote an audit row. So a workflow whose schedule was held, whose API
// call answered 409, or whose MCP invocation was quietly downgraded to a
// preparation run left nothing behind — and "did the limit hold?" could only be
// answered for half the cases.
//
// One action for both, separated by `metadata.stage`, so a single filter
// answers that question end to end instead of two that have to be remembered.

import { AuditAction, type AuditActorType, auditAwait, sanitizeForAudit } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import { logger } from "../logging/logger.ts";

export interface AdmissionRefusal {
  tenant_id: string;
  /** The engine's own code — `execution_authority_required` and its siblings. */
  reason: string;
  message?: string | null;
  workflow_id?: string | null;
  /** Present when admission got far enough to have a row for it. */
  execution_id?: string | null;
  request_source: string;
  actor_id?: string | null;
  /** Project a resolved principal with `actorType()`; omit only where there
   *  is none (the scheduler, the queue), which files it as actor-less. */
  actor_type?: AuditActorType;
  /** Anything the surface knows that a reader would otherwise have to guess. */
  extra?: Record<string, unknown>;
}

/**
 * Record that admission refused, in the terms the trail already uses.
 *
 * Deliberately not thrown from inside `authority-admission.ts`: the refusal
 * there is a `throw` with no knowledge of who asked or through which surface,
 * and an audit row without those is a row nobody can act on. The callers have
 * both, so they write it.
 *
 * Never throws. `writeAudit` propagates an insert failure, and every caller
 * here stands between a refusal and the answer that refusal becomes: in a
 * route it would turn a clean 409 into a 500, and in the queue handler it
 * would finalize the execution row with the AUDIT error's message — corrupting
 * the trail at the one moment it matters. The failure conditions are the same
 * ones that make the write fail (pool exhaustion), so this cannot be left to
 * each caller to remember. The refusal still reaches the journal at `error`
 * level, so the fact survives even when the table write did not.
 */
export async function auditAdmissionRefusal(input: AdmissionRefusal, db: Executor): Promise<void> {
  try {
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_type ?? "system",
        actor_id: input.actor_id ?? null,
        action: AuditAction.EXECUTION_BOUNDARY_REFUSED,
        // The execution when there is one, else the workflow — a resource id
        // that resolves to nothing is worse than a coarser one that does.
        resource_type: input.execution_id ? "execution" : "workflow",
        resource_id: input.execution_id ?? input.workflow_id ?? input.tenant_id,
        result: "denied",
        reason: input.reason,
        metadata: {
          stage: "admission",
          request_source: input.request_source,
          ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
          // Engine-authored prose naming what was asked for and what was
          // approved. It can quote a caller-supplied id, so it goes through
          // the same bound every other operator-derived audit string does.
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
