import type { ModelMessage } from "ai";

export function dropAssistantTail(messages: ModelMessage[]): ModelMessage[] {
  const hasGroundTurn = messages.some((m) => m.role === "user" || m.role === "tool");
  if (!hasGroundTurn) return messages;
  const out = [...messages];
  while (out.length > 0 && out[out.length - 1]!.role === "assistant") out.pop();
  return out;
}
