import type { AttentionItem } from "./attention.ts";

export interface OpenQuestion {
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly local: boolean;
}

export function conversationAttentionItem(
  conversation: { readonly id: string; readonly title: string | null; readonly updated_at: Date },
  question: OpenQuestion | undefined,
  href: string,
): AttentionItem {
  const local = question?.local === true;
  return {
    id: `conversation:${conversation.id}`,
    class: local ? "decide" : "stopped",
    severity: "urgent",
    kind: local ? "local_confirmation" : "conversation",
    subject: { kind: "conversation", id: conversation.id, name: conversation.title },
    reason: local ? "local_confirmation_needed" : "awaiting_answer",
    trigger: null,
    cause_class: null,
    counts: {},
    since: (question?.created_at ?? conversation.updated_at).toISOString(),
    deadline: question?.expires_at.toISOString() ?? null,
    detail: null,
    actions: [
      {
        verb: "answer",
        href,
        primary: true,
        permission: local ? "local:confirm" : "conversation:write",
      },
    ],
  };
}
