import {
  type ActorFields,
  countModelMessagesTokens,
  recordUsage,
} from "../../llm/accounting/index.ts";
import { elicitationActorType } from "../core/loop.ts";
import { createElicitation } from "../elicitations.ts";
import { appendMessage, buildModelMessages } from "../persistence/index.ts";
import type { TurnSignals } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";
import type { AssembledPrompt, RunLoopParams } from "./types.ts";

export function conversationMessages(p: RunLoopParams) {
  return buildModelMessages(p.db, p.tenant_id, p.conversation_id, {
    conversationEnvelope: true,
    conversation_id: p.conversation_id,
  });
}

export function appendVolatileSystemContext(prompt: AssembledPrompt, context: string): void {
  prompt.system += `\n${context}`;
  prompt.system_sections?.push({ text: context, volatile: true });
  const extraTokens = countModelMessagesTokens([{ role: "system", content: context }]);
  prompt.token_counts.system += extraTokens;
  prompt.token_counts.total += extraTokens;
}

export async function appendSyntheticAssistant(
  p: RunLoopParams,
  events: TurnEvent[],
  signals: TurnSignals,
  text: string,
  reason: string,
): Promise<string> {
  const messageId = await appendMessage(p.db, p.tenant_id, p.conversation_id, "assistant", {
    text,
    _synthetic: true,
    _reason: reason,
  });
  events.push({
    type: "message",
    role: "assistant",
    content: { text },
    id: messageId,
    parent_message_id: messageId,
  });
  signals.lastAssistantText = text;
  signals.lastAssistantMessageId = messageId;
  return messageId;
}

export function recordFailedUsage(
  p: RunLoopParams,
  actor: ActorFields,
  failure: {
    model: string;
    prompt_tokens: number;
    result: "error" | "quota_exhausted";
    error: string;
  },
): Promise<void> {
  return recordUsage(
    {
      tenant_id: p.tenant_id,
      flow: "converse",
      model: failure.model,
      prompt_tokens: failure.prompt_tokens,
      completion_tokens: 0,
      latency_ms: 0,
      result: failure.result,
      error: failure.error,
      conversation_id: p.conversation_id,
      ...actor,
    },
    p.db,
  );
}

export function askUserText(
  p: RunLoopParams,
  request: { summary: string; input: Record<string, unknown> },
) {
  return createElicitation(
    {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool_call_id: null,
      tool_name: "ask_user_text",
      summary: request.summary,
      input: request.input,
      actor_id: p.actor_id,
      actor_type: elicitationActorType(p.principal?.kind, p.actor_id),
    },
    p.db,
  );
}
