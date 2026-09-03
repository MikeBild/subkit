// What a conversation is called in the list, what the second line says, and
// how old it is.
//
// The list is a way back into a conversation, not a queue: a row names the
// goal, says what the conversation was about or where it got to, and shows
// when it last moved. The status word is deliberately absent — "active" is
// the engine's authoring state, not something a reader can act on, and the
// second line used to show it exactly when the list had nothing else to say.

import { clipAtWord } from "@/lib/presentation";

/** Titles live in a narrow rail; past this they stop being scannable. */
export const TITLE_MAX = 72;

export interface ConversationRowInput {
  title?: string | null | undefined;
  last_message_role?: string | null | undefined;
  last_message_excerpt?: string | null | undefined;
  outcome?: string | null | undefined;
  target_workflow?: { name: string | null; slug: string | null } | null | undefined;
  target_connector?: { name: string | null; slug: string | null } | null | undefined;
}

export interface ConversationRow {
  title: string;
  /** Second line, or null when there is nothing beyond the title to say. */
  secondary: string | null;
  /** True when the title is a real name rather than a borrowed excerpt. */
  named: boolean;
  /** The row needs the reader: a question is waiting. */
  waiting: boolean;
}

/** Clip a title to the rail's width. The rule itself lives in `lib/presentation`
 *  because the decision queue clips conversation prose too. */
export function clipTitle(text: string, max = TITLE_MAX): string {
  return clipAtWord(text, max);
}

export interface ConversationRowLabels {
  untitled: string;
  /** Excerpt already run through `conversationExcerpt`, or null. */
  excerpt: string | null;
}

/** The object a conversation is about, as a name — never an id. */
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
    // The object it is about beats the last thing said: "Monatsreport" tells
    // a reader more than a clipped sentence from the transcript.
    const secondary =
      target && target !== title ? target : excerpt && excerpt !== title ? excerpt : null;
    return { title: clipTitle(title), secondary, named: true, waiting };
  }
  if (excerpt) {
    // Borrowing the last message as the title is honest — it is what this
    // conversation is about — but then the second line must not repeat it.
    return { title: clipTitle(excerpt), secondary: target, named: false, waiting };
  }
  return { title: labels.untitled, secondary: target, named: false, waiting };
}
