export type ConversationSelection =
  { kind: "automatic" } | { kind: "new" } | { kind: "existing"; id: string };

export function activeConversationId(
  selection: ConversationSelection,
  firstConversationId: string | null | undefined,
): string | null {
  if (selection.kind === "new") return null;
  if (selection.kind === "existing") return selection.id;
  return firstConversationId ?? null;
}
