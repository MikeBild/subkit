import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordToolPolicyConfirmationRequiredParams extends RecorderBase {
  conversation_id: string;
  tool: string;
  mode: string;
  confirmation_kind: string | null;
  resolver_reason: string | null;
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
