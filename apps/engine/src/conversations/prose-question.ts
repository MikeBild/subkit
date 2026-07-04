// Closing-prose-question detection for turn finalization.
//
// A turn that ends with the assistant asking a question in PROSE — no
// ask_user_* tool call — is a dead end on unattended surfaces: the
// client sees a terminal status, nobody surfaces the question, and the
// conversation stalls. The loop parks such turns on an ask_user_text
// elicitation carrying the model's own closing ask (see loop.ts turn
// finalization); this module owns the deterministic detection so it is
// unit-testable in isolation.

/** Cap so a long closing narration doesn't bloat the elicitation dialog. */
const CLOSING_ASK_MAX_CHARS = 600;

/**
 * Return the assistant's closing ask (its final paragraph) when the
 * turn's last assistant text ends on a direct question, else `null`.
 * Deliberately conservative: only a trailing `?` on the LAST non-empty
 * line counts — mid-text rhetorical questions never trigger.
 */
export function closingProseQuestion(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastLine =
    trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  if (!lastLine.endsWith("?")) return null;
  const paragraphs = trimmed.split(/\n\s*\n/);
  const closing = (paragraphs.at(-1) ?? lastLine).trim();
  return closing.slice(-CLOSING_ASK_MAX_CHARS);
}
