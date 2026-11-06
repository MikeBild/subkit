import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { recordConversationToolCall } from "../../observability/instrumentation.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../persistence/index.ts";
import type { ToolCallOutcome } from "../tools/result-payload.ts";
import type { ConversationStatus, TurnEvent } from "../types.ts";
import type { FastPathHit, FastPathParams } from "./types.ts";

export async function persistFastPathTurn(
  p: FastPathParams,
  tool: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  reply: string,
  outcome: ToolCallOutcome,
  confirmation_data?: Record<string, unknown>,
): Promise<{ events: TurnEvent[]; assistant_message_id: string; tool_call_id: string }> {
  await appendMessage(p.db, p.tenant_id, p.conversation_id, "tool", { tool, output });
  const assistantMessageId = await appendMessage(
    p.db,
    p.tenant_id,
    p.conversation_id,
    "assistant",
    { text: reply, fast_path: true },
  );
  const toolCallId = await insertToolCall(p.db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    parent_message_id: assistantMessageId,
    tool,
    input,
    approval_required: false,
    ...(confirmation_data ? { confirmation_data } : {}),
  });
  await updateToolCallOutput(p.db, toolCallId, output, outcome);
  const events: TurnEvent[] = [
    {
      type: "tool_call_start",
      call_id: toolCallId,
      tool,
      input_partial: input,
      parent_message_id: assistantMessageId,
    },
    {
      type: "tool_call_end",
      call_id: toolCallId,
      input,
      parent_message_id: assistantMessageId,
    },
    {
      type: "tool_result",
      call_id: toolCallId,
      tool,
      output,
      parent_message_id: assistantMessageId,
    },
    {
      type: "message",
      role: "assistant",
      content: reply,
      id: assistantMessageId,
    },
  ];
  return { events, assistant_message_id: assistantMessageId, tool_call_id: toolCallId };
}

export interface FastPathAnswer {
  tool: string;
  category: "tenant_read" | "tenant_write";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  reply: string;
  outcome: ToolCallOutcome;
  status?: ConversationStatus;
  confirmation_data?: Record<string, unknown>;
}

export async function answerFastPath(p: FastPathParams, a: FastPathAnswer): Promise<FastPathHit> {
  const persisted = await persistFastPathTurn(
    p,
    a.tool,
    a.input,
    a.output,
    a.reply,
    a.outcome,
    a.confirmation_data,
  );
  recordConversationToolCall({
    category: a.category,
    tool: a.tool,
    outcome: a.outcome,
    duration_ms: 0,
  });
  return {
    status: a.status ?? "active",
    events: persisted.events,
    fast_path_tool: a.tool,
    assistant_text: a.reply,
  };
}

export async function auditPolicyDenied(
  p: FastPathParams,
  permission: string,
  tool: string,
  reason: string,
  resource?: { type: string; id: string },
): Promise<void> {
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.principal.kind,
      actor_id: p.principal.id,
      action: AuditAction.POLICY_DENIED,
      resource_type: resource?.type ?? "conversation",
      resource_id: resource?.id ?? p.conversation_id,
      result: "denied",
      reason,
      metadata: {
        tool,
        via: "fast_path",
        provider: p.principal.provider,
        permission,
      },
    },
    p.db,
  );
}
