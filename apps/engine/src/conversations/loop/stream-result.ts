export function throwForStreamError(finishReason: string, error: unknown): void {
  if (finishReason !== "error") return;
  throw error ?? new Error("Conversation model stream failed without an error detail.");
}
