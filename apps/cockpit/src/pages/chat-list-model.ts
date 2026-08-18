// What a conversation is called in the list, and what the second line says.
//
// The engine never wrote a title, so every row read as the same placeholder
// word and the list was unusable as a way back into a conversation. The engine
// now names new conversations from their first request and a boot backfill
// names the old ones — but a conversation that has genuinely never carried a
// user message still has no title, and a fallback that stops at the placeholder
// throws away the excerpt the list already has in hand.
//
// So: prefer the name, then the person's own words, then anything else that was
// said, and only then admit there is nothing to show.

/** Titles live in a narrow rail; past this they stop being scannable. */
export const TITLE_MAX = 72;

export interface ConversationRowInput {
  title?: string | null | undefined;
  status: string;
  last_message_role?: string | null | undefined;
  last_message_excerpt?: string | null | undefined;
}

export interface ConversationRow {
  title: string;
  /** Second line, or null when it would only repeat the title. */
  secondary: string | null;
  /** True when the title is a real name rather than a borrowed excerpt. */
  named: boolean;
}

/**
 * Clip at a word boundary.
 *
 * A clipped title and a wrapped excerpt are different facts, so this happens in
 * the model rather than through `line-clamp`: a reader can tell that the text
 * was cut, and the second line is free to say something else.
 */
export function clipTitle(text: string, max = TITLE_MAX): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  const cut = squashed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

export interface ConversationRowLabels {
  untitled: string;
  /** Already-localized status word for this conversation. */
  status: string;
  /** Excerpt already run through `conversationExcerpt`, or null. */
  excerpt: string | null;
}

export function conversationRow(
  conversation: ConversationRowInput,
  labels: ConversationRowLabels,
): ConversationRow {
  const title = conversation.title?.trim();
  if (title) {
    return {
      title: clipTitle(title),
      secondary: labels.excerpt && labels.excerpt !== title ? labels.excerpt : labels.status,
      named: true,
    };
  }
  const excerpt = labels.excerpt?.trim();
  if (excerpt) {
    // Borrowing the last message as the title is honest — it is what this
    // conversation is about — but then the second line must not repeat it.
    return { title: clipTitle(excerpt), secondary: labels.status, named: false };
  }
  return { title: labels.untitled, secondary: labels.status, named: false };
}
