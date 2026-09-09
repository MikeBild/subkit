// Tool-policy audit recorder.
//
// Emitted by `conversations/tools/sdk-wrap/invoke.ts` whenever the
// enforcement resolver (`decideToolMode`) decides a tool call must pause
// for human confirmation. Operators can SELECT these rows to answer "what
// tools paused the loop today, and why" — the resolver previously logged
// at debug level only, which is non-durable and tenant-blind.
//
// Every field below is sourced from the decision the confirm gate ACTS on.
// An audit row describing a mode nothing enforced is worse than no row.

import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordToolPolicyConfirmationRequiredParams extends RecorderBase {
  conversation_id: string;
  tool: string;
  /** Enforced execution mode — typically "confirm_before_execution". */
  mode: string;
  /** Kind stamped on the `ask_user_confirm` the gate raises for this tool. */
  confirmation_kind: string | null;
  /** The `ToolModeRule` branch that produced the mode (e.g. "sensitive_input"). */
  resolver_reason: string | null;
  /** Environment the call named, when the enforcement table routed on it. */
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

export interface RecordToolPolicyConfirmCollapsedMcpParams extends RecorderBase {
  conversation_id: string;
  tool: string;
  /** Enforced execution mode — always "confirm_before_execution" here. */
  mode: string;
  /** The `ToolModeRule` branch that produced the mode. */
  resolver_reason: string | null;
}

/**
 * @deprecated Historical audit compatibility only. Runtime dispatch no longer
 * treats an MCP client hint as an approval and never emits this event. Keep the
 * event shape readable for installations with older audit records.
 */
export async function recordToolPolicyConfirmCollapsedMcp(
  p: RecordToolPolicyConfirmCollapsedMcpParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.TOOL_POLICY_CONFIRM_COLLAPSED_MCP,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      reason: "mcp_client_dialog_gate",
      metadata: {
        conversation_id: p.conversation_id,
        tool: p.tool,
        mode: p.mode,
        resolver_reason: p.resolver_reason,
        gate: "mcp_client_destructive_hint_dialog",
      },
    },
    p.executor,
  );
}
