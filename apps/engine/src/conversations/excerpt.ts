// Human-facing display text derived from a conversation message.
//
// Two consumers with different lengths and the same rules: the conversation
// list's `last_message_excerpt` (140 chars) and the auto-derived conversation
// title (50 chars, see `title.ts`). They live here together so a change to the
// sentinel stripping or the ellipsis rule cannot reach one and miss the other —
// a title and an excerpt that disagree about what a message said is exactly the
// kind of drift a second copy produces.

import { stripFileSentinelsForDisplay } from "../files/sentinel.ts";

/**
 * Reduce a persisted message `content` to one line of human-readable text.
 *
 * Every `[file:fid_<uuid>]` sentinel is stripped to a `[file]` placeholder so
 * the raw fid never lands in a UI list, a title or a notification body. The
 * conversation list is rendered to operators; a leaked sentinel is both
 * unreadable and a low-grade information disclosure (the fid is tenant-scoped
 * but still an internal id).
 *
 * Returns `null` when the content carries nothing worth showing.
 */
export function stringifyConversationExcerpt(content: unknown): string | null {
  const stripped = (raw: string): string => stripFileSentinelsForDisplay(raw);
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? stripped(trimmed) : null;
  }
  if (content === null || content === undefined) return null;
  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string" && obj.text.trim().length > 0) {
      return stripped(obj.text.trim());
    }
    if (typeof obj.summary === "string" && obj.summary.trim().length > 0) {
      return stripped(obj.summary.trim());
    }
  }
  try {
    const raw = JSON.stringify(content);
    return raw.length > 2 ? stripped(raw) : null;
  } catch {
    return stripped(String(content));
  }
}

/**
 * Squash whitespace and clip to at most `max`, marking a clipped string with `…`.
 *
 * The clip prefers the last word boundary inside the budget. "Reauthenticate the
 * existing Anthropic connector b…" makes a reader guess at a word the text
 * already contained; stopping at "connector" costs one word and guesses at
 * nothing. The boundary is preferred, not required — a run with no space near
 * the limit (a URL, an id, a script with no spaces) still clips hard rather than
 * collapsing to a fragment, which is why the back-off is refused when it would
 * spend more than half the budget.
 */
export function truncateExcerpt(text: string, max = 140): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  const budget = Math.max(1, max - 1);
  const clipped = squashed.slice(0, budget);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace * 2 >= budget ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}
