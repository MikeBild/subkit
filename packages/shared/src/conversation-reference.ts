export const CONVERSATION_REFERENCE_TYPES = [
  "workflow",
  "connector",
  "skill",
  "knowledge_source",
  "execution",
  "intake_item",
] as const;

export type ConversationReferenceType = (typeof CONVERSATION_REFERENCE_TYPES)[number];

export interface ConversationReference {
  type: ConversationReferenceType;
  id: string;
  label: string;
}

export function isConversationReferenceType(value: unknown): value is ConversationReferenceType {
  return (
    typeof value === "string" &&
    CONVERSATION_REFERENCE_TYPES.includes(value as ConversationReferenceType)
  );
}
