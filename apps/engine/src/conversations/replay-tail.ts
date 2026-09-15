import type { ModelMessage } from "ai";

/**
 * Enforce the provider contract that a `messages` array must not END on an
 * assistant turn — Anthropic reads that as an attempt to prefill the reply and
 * answers "This model does not support assistant message prefill. The
 * conversation must end with a user message."
 *
 * A replayed conversation can end on assistant whenever the last thing that
 * happened was the model speaking and the turn is resumed by something other
 * than the user typing: a resolved elicitation or approval re-enqueues
 * `conversation.run-turn` with no `currentUserMessage`, and
 * `empty_turn_fallback` (see `loop.ts`) appends a SYNTHETIC assistant message
 * after the tool rows, so it lands last in `created_at` order.
 *
 * Dropping the tail is safe and non-inventive: that text was already delivered
 * to the user, and whatever drives the resume — the tool result or elicitation
 * outcome — sits earlier in the array and is preserved. The alternative,
 * appending a synthetic user turn, would put words the user never said into the
 * main converse loop. (`llm/core/suggestion-prompt.ts` does append one, but its
 * whole task is "predict what the user would type next", so a user-framed nudge
 * is the prompt rather than a fabrication.)
 *
 * Never strips the array down to nothing: if no user/tool turn survives
 * underneath, the trailing assistant message is the only conversational content
 * there is and removing it would send an empty array, which providers reject too.
 */
export function dropAssistantTail(messages: ModelMessage[]): ModelMessage[] {
  const hasGroundTurn = messages.some((m) => m.role === "user" || m.role === "tool");
  if (!hasGroundTurn) return messages;
  const out = [...messages];
  while (out.length > 0 && out[out.length - 1]!.role === "assistant") out.pop();
  return out;
}
