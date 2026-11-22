import type { ConversationReference, UiMessage } from "@/api/client";
import type { SidePanelSubject } from "./side-panel-model";

export type PanelReferenceType = ConversationReference["type"];

const REFERENCE_TYPES: Partial<Record<SidePanelSubject["type"], PanelReferenceType>> = {
  workflow: "workflow",
  connector: "connector",
  skill: "skill",
  knowledge_source: "knowledge_source",
};

export function panelReference(
  subject: SidePanelSubject | null,
  label: string | null,
): ConversationReference | null {
  const type = subject ? REFERENCE_TYPES[subject.type] : undefined;
  if (!subject || !type) return null;
  return { type, id: subject.id, label: label?.trim() || subject.id };
}

export function panelTarget(
  subject: SidePanelSubject | null,
): { workflow_id: string } | { connector_id: string } | undefined {
  if (subject?.type === "workflow") return { workflow_id: subject.id };
  if (subject?.type === "connector") return { connector_id: subject.id };
  return undefined;
}

export function panelSubjectKey(subject: SidePanelSubject | null): string {
  return subject ? `${subject.type}:${subject.id}` : "workspace";
}

export function panelConversationId(input: {
  subject: SidePanelSubject | null;
  thread: string | null;
  task: { conversationId: string | null; ownerId: string | null } | null;
  viewer: { id: string | null; admin: boolean };
}): string | null {
  if (input.thread) return input.thread;
  if (input.subject?.type !== "task" || !input.task?.conversationId) return null;
  const mayContinue =
    input.viewer.admin || (input.viewer.id !== null && input.viewer.id === input.task.ownerId);
  return mayContinue ? input.task.conversationId : null;
}

export interface PanelLine {
  id: string;
  author: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

export function messageText(message: Pick<UiMessage, "parts">): string {
  return message.parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function panelLines(input: {
  messages: readonly Pick<UiMessage, "id" | "role" | "parts">[];
  sent: string | null;
  streamed: string;
}): PanelLine[] {
  const lines: PanelLine[] = [];
  for (const message of input.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageText(message);
    if (!text) continue;
    lines.push({ id: message.id, author: message.role, text });
  }
  const last = lines[lines.length - 1];
  if (input.sent && !(last?.author === "user" && last.text === input.sent.trim()))
    lines.push({ id: "pending-user", author: "user", text: input.sent.trim() });
  if (input.streamed.trim())
    lines.push({
      id: "pending-answer",
      author: "assistant",
      text: input.streamed,
      streaming: true,
    });
  return lines;
}
