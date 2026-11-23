import { log } from "../../../../logging/index.ts";
import { stampMcpTaskProgress } from "../../../../mcp/tasks/store.ts";
import { appendMessage, insertToolCall } from "../../../persistence/index.ts";
import { toolRetry } from "../../../retry-activity.ts";
import { computeLineDiff } from "../../../text-line-diff.ts";
import type { ToolContext } from "../../index.ts";
import { redactToolArgsForPersist } from "../redact-tool-args.ts";
import type { InvokeCall, InvokeEnv } from "./env.ts";
import { logFirstToolMemory } from "./memory.ts";

async function ensureAssistantMessageAnchor(env: InvokeEnv): Promise<string> {
  const { signals, db, ctx } = env;
  if (signals.assistantMessageId) return signals.assistantMessageId;
  const messageId = await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "assistant", {});
  signals.assistantMessageId = messageId;
  return messageId;
}

function perCallContext(
  env: InvokeEnv,
  toolCallId: string,
  assistantMessageId: string,
): ToolContext {
  const { ctx, events, inner } = env;
  return {
    ...ctx,
    tool_call_id: toolCallId,
    assistant_message_id: assistantMessageId,
    onLog: (level, message) => {
      events.push({
        type: "tool_log",
        call_id: toolCallId,
        tool: inner.name,
        level,
        message,
        ts: new Date().toISOString(),
      });
    },
    emitDiff: ({ title, language, before, after }) => {
      try {
        const hunks = computeLineDiff(before, after, { context: 3 });
        if (hunks.length === 0) return;
        events.push({ type: "diff", title, language, hunks });
      } catch {}
    },
  };
}

export async function startCall(
  env: InvokeEnv,
  rawArgs: Record<string, unknown>,
  argsHash: string,
): Promise<InvokeCall> {
  const { inner, ctx, signals, events, db } = env;
  if (signals.step === 0) await logFirstToolMemory(inner.name);
  const step = signals.step++;
  const startedAt = Date.now();
  const assistantMessageId = await ensureAssistantMessageAnchor(env);
  const toolCallId = await insertToolCall(db, {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    parent_message_id: assistantMessageId,
    tool: inner.name,
    input: redactToolArgsForPersist(inner.name, rawArgs),
    approval_required: inner.name.startsWith("ask_user_"),
  });
  await stampMcpTaskProgress(ctx.tenant_id, ctx.conversation_id, inner.name, rawArgs, db);
  signals.pendingChildToolCallIds.push(toolCallId);
  events.push({
    type: "tool_call_start",
    call_id: toolCallId,
    tool: inner.name,
    input_partial: rawArgs,
    parent_message_id: assistantMessageId,
  });
  events.push({
    type: "tool_call_end",
    call_id: toolCallId,
    input: rawArgs,
    parent_message_id: assistantMessageId,
  });
  events.push({
    type: "activity",
    phase: "tool",
    label: inner.name,
    tool_name: inner.name,
    call_id: toolCallId,
    ...toolRetry(signals, inner.name),
  });
  log.conversation.tool.called({ conversation_id: ctx.conversation_id, tool: inner.name, step });
  return {
    rawArgs,
    argsHash,
    step,
    startedAt,
    toolCallId,
    assistantMessageId,
    perCallCtx: perCallContext(env, toolCallId, assistantMessageId),
  };
}
