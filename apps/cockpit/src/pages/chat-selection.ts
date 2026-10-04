export type ConversationSelection =
  | { kind: "automatic" }
  | { kind: "new" }
  | { kind: "existing"; id: string };

export function activeConversationId(
  selection: ConversationSelection,
  firstConversationId: string | null | undefined,
): string | null {
  if (selection.kind === "new") return null;
  if (selection.kind === "existing") return selection.id;
  return firstConversationId ?? null;
}

export function pinSelectionForSend(
  selection: ConversationSelection,
  firstConversationId: string | null | undefined,
): Exclude<ConversationSelection, { kind: "automatic" }> {
  if (selection.kind !== "automatic") return selection;
  return firstConversationId ? { kind: "existing", id: firstConversationId } : { kind: "new" };
}
