// Tool-policy audit recorder.
//
// Emitted by `loop.ts` whenever the per-turn policy resolver decides a
// tool call must pause for human confirmation. Operators can SELECT
// these rows to answer "what tools paused the loop today, and why" —
// the resolver previously logged at debug level only, which is
// non-durable and tenant-blind.

import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordToolPolicyConfirmationRequiredParams extends RecorderBase {
  conversation_id: string;
  tool: string;
  /** Resolved execution mode — typically "confirm_before_execution". */
  mode: string;
  /** Confirmation kind the resolver picked, if any (e.g. "save_workflow_draft"). */
  confirmation_kind: string | null;
  /** Resolver's structured reason — pushes through to the audit row's reason. */
  resolver_reason: string | null;
  /** Tool environment hint when the resolver routed on it. */
  environment?: string | null;
}

export async function recordToolPolicyConfirmationRequired(
  p: RecordToolPolicyConfirmationRequiredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "denied",
      reason: "confirm_before_execution",
      metadata: {
        conversation_id: p.conversation_id,
        tool: p.tool,
        mode: p.mode,
        confirmation_kind: p.confirmation_kind,
        resolver_reason: p.resolver_reason,
        ...(p.environment !== undefined ? { environment: p.environment } : {}),
      },
    },
    p.executor,
  );
}
