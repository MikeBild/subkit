import { clipAtWord } from "@/lib/presentation";

export const TITLE_MAX = 72;

interface ConversationRowInput {
  title?: string | null | undefined;
  last_message_role?: string | null | undefined;
  last_message_excerpt?: string | null | undefined;
  outcome?: string | null | undefined;
  target_workflow?: { name: string | null; slug: string | null } | null | undefined;
  target_connector?: { name: string | null; slug: string | null } | null | undefined;
}

export interface ConversationRow {
  title: string;
  secondary: string | null;
  named: boolean;
  waiting: boolean;
}

export function clipTitle(text: string, max = TITLE_MAX): string {
  return clipAtWord(text, max);
}

export interface ConversationRowLabels {
  untitled: string;
  excerpt: string | null;
}

function targetName(conversation: ConversationRowInput): string | null {
  const target = conversation.target_workflow ?? conversation.target_connector;
  if (!target) return null;
  return target.name || target.slug || null;
}

export function conversationRow(
  conversation: ConversationRowInput,
  labels: ConversationRowLabels,
): ConversationRow {
  const waiting = conversation.outcome === "awaiting_you";
  const title = conversation.title?.trim();
  const target = targetName(conversation);
  const excerpt = labels.excerpt?.trim() || null;
  if (title) {
    return {
      title: clipTitle(title),
      secondary: target && target !== title ? target : null,
      named: true,
      waiting,
    };
  }
  if (excerpt) return { title: clipTitle(excerpt), secondary: target, named: false, waiting };
  return { title: labels.untitled, secondary: target, named: false, waiting };
}
