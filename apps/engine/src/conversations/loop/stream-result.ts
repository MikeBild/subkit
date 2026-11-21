import { isToolChoiceViolation } from "../../llm/runtime/sdk-errors.ts";

export function answeredDespiteToolChoice(error: unknown): boolean {
  if (!isToolChoiceViolation(error)) return false;
  if (error.content.some((part) => part.type === "tool-call")) return false;
  return error.content.some((part) => part.type === "text" && part.text.trim().length > 0);
}

export function throwForStreamError(finishReason: string, error: unknown): void {
  if (finishReason !== "error") return;
  if (answeredDespiteToolChoice(error)) return;
  throw error ?? new Error("Conversation model stream failed without an error detail.");
}
