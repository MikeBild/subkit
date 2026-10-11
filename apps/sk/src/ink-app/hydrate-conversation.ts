import { applyTurnEvent, initialSessionState, type SkSessionState } from "@cli-core/index.ts";
import type { ConversationDetail } from "../engine-client.ts";

export function hydrateConversation(detail: ConversationDetail): SkSessionState {
  let state = initialSessionState(detail.conversation.id);
  for (const message of detail.messages) {
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "system" &&
      message.role !== "tool"
    ) {
      continue;
    }
    state = applyTurnEvent(state, {
      type: "message",
      role: message.role,
      content: message.parts,
      id: message.id,
    });
  }
  for (const call of detail.tool_calls) {
    if (!call || typeof call !== "object") continue;
    const row = call as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.tool !== "string") continue;
    const output = row.output;
    const outcome = row.outcome;
    state = applyTurnEvent(state, {
      type: "tool_call_start",
      call_id: row.id,
      tool: row.tool,
      input_partial: row.input,
      ...(typeof row.parent_message_id === "string"
        ? { parent_message_id: row.parent_message_id }
        : {}),
    });
    if (output !== null && output !== undefined) {
      state = applyTurnEvent(state, {
        type: "tool_result",
        call_id: row.id,
        tool: row.tool,
        output,
        ...(typeof row.parent_message_id === "string"
          ? { parent_message_id: row.parent_message_id }
          : {}),
      });
    } else if (outcome === "pending") {
      state = {
        ...state,
        toolCalls: state.toolCalls.map((item) =>
          item.id === row.id ? { ...item, status: "pending" } : item,
        ),
      };
    }
  }
  const pending = detail.resume_summary?.pending_approval;
  if (pending?.prompt) {
    state = applyTurnEvent(state, {
      type: "elicit_request",
      elicitation_id: pending.id,
      tool_name: pending.tool_name,
      summary: pending.summary,
      input: pending.prompt,
      ...(pending.tool_call_id ? { tool_call_id: pending.tool_call_id } : {}),
    });
  } else if (detail.conversation.status === "completed") {
    state = { ...state, status: "completed" };
  } else if (detail.conversation.status === "error") {
    state = { ...state, status: "error" };
  }
  return state;
}
