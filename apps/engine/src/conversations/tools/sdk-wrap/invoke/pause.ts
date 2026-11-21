import { log, logger } from "../../../../logging/index.ts";
import { pauseInputPayload } from "../../../core/tool-invoke.ts";
import { createElicitation } from "../../../elicitations.ts";
import type { ToolResultPause } from "../../index.ts";
import { prepareGate } from "../gate-subjects.ts";
import { confirmationMetadataForTool, REVIEW_AFTER_EXECUTION_KIND } from "../policy-helpers.ts";
import type { WrappedToolOutput } from "../state.ts";
import { elicitationActor, type InvokeCall, type InvokeEnv } from "./env.ts";
import type { Executed } from "./execute.ts";

export async function forwardToolPause(
  env: InvokeEnv,
  call: InvokeCall,
  pause: ToolResultPause,
): Promise<void> {
  const { inner, ctx, signals, events, db } = env;
  const { rawArgs } = call;
  const inputPayload = pauseInputPayload(pause);
  const enrichedInputPayload =
    inputPayload && typeof inputPayload === "object"
      ? {
          ...confirmationMetadataForTool(inner.name, rawArgs),
          ...(inputPayload as Record<string, unknown>),
        }
      : inputPayload;
  signals.pendingChildElicitationIds.push(pause.elicitation_id);
  const pauseInputRecord =
    inputPayload && typeof inputPayload === "object"
      ? (inputPayload as { pending_output?: Record<string, unknown> })
      : undefined;
  const pausePending =
    pauseInputRecord?.pending_output ??
    (await prepareGate(inner.name, rawArgs, ctx.tenant_id, db, ctx.locale, ctx.principal))
      .pending_output;
  events.push({
    type: "elicit_request",
    elicitation_id: pause.elicitation_id,
    tool_call_id: call.toolCallId,
    tool_name: pause.tool_name,
    summary: pause.summary,
    input: enrichedInputPayload,
    parent_message_id: call.assistantMessageId,
    ...(pausePending ? { pending_output: pausePending } : {}),
  });
  log.conversation.approval.requested({
    conversation_id: ctx.conversation_id,
    approval_id: pause.elicitation_id,
    kind: pause.kind ?? pause.tool_name,
  });
  signals.pendingElicitation = {
    elicitation_id: pause.elicitation_id,
    tool_name: pause.tool_name,
    summary: pause.summary,
    input: enrichedInputPayload,
  };
}

export function markCommitted(env: InvokeEnv, call: InvokeCall, committedWorkflowId: string): void {
  env.events.push({ type: "committed", workflow_id: committedWorkflowId });
  log.conversation.completed({
    conversation_id: env.ctx.conversation_id,
    final_status: "committed",
    committed_workflow_id: committedWorkflowId,
    steps_taken: call.step + 1,
  });
  env.signals.committed = { workflow_id: committedWorkflowId };
}

export async function pauseForReview(
  env: InvokeEnv,
  call: InvokeCall,
  executed: Executed,
  committedWorkflowId: string | null,
): Promise<WrappedToolOutput> {
  const { inner, ctx, signals, events, db } = env;
  const { rawArgs, toolCallId, assistantMessageId } = call;
  const { result, resultPayload, modelVisibleOutput } = executed;
  const reviewElicitation = await createElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: toolCallId,
      parent_message_id: assistantMessageId,
      tool_name: "ask_user_confirm",
      summary: `Review result of ${inner.name}`,
      input: {
        kind: REVIEW_AFTER_EXECUTION_KIND,
        summary: `Review result of ${inner.name}`,
        target: { tool: inner.name, args: rawArgs },
        ...confirmationMetadataForTool(inner.name, rawArgs),
        pending_output: resultPayload,
      },
      ...elicitationActor(ctx),
    },
    db,
  );
  const reviewElicitationId = reviewElicitation.id;
  signals.pendingChildElicitationIds.push(reviewElicitationId);
  const reviewInput = () => ({
    kind: REVIEW_AFTER_EXECUTION_KIND,
    question: `${inner.name} ran. Keep this result?`,
    target: { tool: inner.name, args: rawArgs },
    ...confirmationMetadataForTool(inner.name, rawArgs),
  });
  events.push({
    type: "elicit_request",
    elicitation_id: reviewElicitationId,
    tool_call_id: toolCallId,
    tool_name: "ask_user_confirm",
    summary: `Review result of ${inner.name}`,
    input: reviewInput(),
    parent_message_id: assistantMessageId,
    pending_output: resultPayload as Record<string, unknown>,
  });
  log.conversation.approval.requested({
    conversation_id: ctx.conversation_id,
    approval_id: reviewElicitationId,
    kind: REVIEW_AFTER_EXECUTION_KIND,
  });
  signals.pendingElicitation = {
    elicitation_id: reviewElicitationId,
    tool_name: "ask_user_confirm",
    kind: REVIEW_AFTER_EXECUTION_KIND,
    summary: `Review result of ${inner.name}`,
    input: reviewInput(),
  };
  logger.info({
    module: "conversation_tool",
    action: "post_execution_pause.created",
    msg: "tool ran; pausing for operator review (confirm_after_execution)",
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    elicitation_id: reviewElicitationId,
  });
  return {
    ok: result.ok,
    data: modelVisibleOutput,
    pause: {
      tool_name: "ask_user_confirm",
      kind: "generic",
      summary: `Review result of ${inner.name}`,
      elicitation_id: reviewElicitationId,
      input: {
        kind: REVIEW_AFTER_EXECUTION_KIND,
        question: `${inner.name} ran. Keep this result?`,
        target: { tool: inner.name, args: rawArgs },
      },
    },
    ...(committedWorkflowId ? { committed_workflow_id: committedWorkflowId } : {}),
  };
}
