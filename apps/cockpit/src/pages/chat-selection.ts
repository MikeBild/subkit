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

/**
 * The selection a send is made under, fixed at the moment it is sent.
 *
 * "Automatic" follows the list: its target is whichever conversation the list
 * names first, and that changes when the list arrives or reorders. A send
 * made under it would change target in mid-flight — a request typed before
 * the list loaded is a creation, and must stay one when a waiting
 * conversation turns up at the top of the list a moment later.
 */
export function pinSelectionForSend(
  selection: ConversationSelection,
  firstConversationId: string | null | undefined,
): Exclude<ConversationSelection, { kind: "automatic" }> {
  if (selection.kind !== "automatic") return selection;
  return firstConversationId ? { kind: "existing", id: firstConversationId } : { kind: "new" };
}
