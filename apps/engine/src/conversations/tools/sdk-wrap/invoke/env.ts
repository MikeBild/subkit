import type { Db } from "../../../../db/client.ts";
import { recordConversationToolCall } from "../../../../observability/instrumentation.ts";
import type { PermissionMode, ToolPolicies } from "../../../../tools/types.ts";
import type { PolicyRecord } from "../../../instruction-cover/gate.ts";
import { updateToolCallOutput } from "../../../persistence/index.ts";
import type { TurnEvent } from "../../../types.ts";
import type { ConversationTool, ToolContext } from "../../index.ts";
import type { ToolCallOutcome } from "../../result-payload.ts";
import type { TurnSignals } from "../state.ts";

export interface InvokeEnv {
  inner: ConversationTool;
  ctx: ToolContext;
  signals: TurnSignals;
  events: TurnEvent[];
  db: Db;
  toolPolicies: ToolPolicies;
  permissionMode: PermissionMode | null;
  release: () => void;
  because?: string | null;
}

export interface InvokeCall {
  rawArgs: Record<string, unknown>;
  argsHash: string;
  step: number;
  startedAt: number;
  toolCallId: string;
  assistantMessageId: string;
  perCallCtx: ToolContext;
  policyRecord?: PolicyRecord | null;
}

export function pushToolLog(env: InvokeEnv, call_id: string, message: string): void {
  env.events.push({
    type: "tool_log",
    call_id,
    tool: env.inner.name,
    level: "warn",
    message,
    ts: new Date().toISOString(),
  });
}

export async function persistToolResult(
  env: InvokeEnv,
  call: InvokeCall,
  output: unknown,
  outcome: ToolCallOutcome,
): Promise<void> {
  await updateToolCallOutput(env.db, call.toolCallId, output, outcome);
  pushToolResult(env, call, output);
}

export function pushToolResult(env: InvokeEnv, call: InvokeCall, output: unknown): void {
  env.events.push({
    type: "tool_result",
    call_id: call.toolCallId,
    tool: env.inner.name,
    output,
    parent_message_id: call.assistantMessageId,
  });
}

export function recordCall(
  env: InvokeEnv,
  call: InvokeCall,
  outcome: "ok" | "error" | "denied",
): void {
  recordConversationToolCall({
    category: env.inner.category,
    tool: env.inner.name,
    outcome,
    duration_ms: Date.now() - call.startedAt,
  });
}

export function elicitationActor(ctx: ToolContext) {
  return {
    actor_id: ctx.engineClient.context.actor_id,
    ...(ctx.engineClient.context.actor_type
      ? { actor_type: ctx.engineClient.context.actor_type }
      : {}),
  };
}
