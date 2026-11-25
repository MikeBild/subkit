export interface PersonConversation {
  readonly id: string;
  readonly title: string | null;
  readonly content_hidden?: boolean | null;
  readonly updated_at: string;
}

export interface PersonConversationRow {
  readonly id: string;
  readonly hidden: boolean;
  readonly title: string;
  readonly updated_at: string;
}

export function personConversationRow(
  conversation: PersonConversation,
  labels: { readonly hidden: string; readonly untitled: string },
): PersonConversationRow {
  const hidden = conversation.content_hidden === true;
  const title = conversation.title?.trim();
  return {
    id: conversation.id,
    hidden,
    title: hidden ? labels.hidden : title || labels.untitled,
    updated_at: conversation.updated_at,
  };
}

export function mayDeletePersonConversations(permissions: readonly string[]): boolean {
  return permissions.includes("identity:write") && permissions.includes("conversation:write");
}
