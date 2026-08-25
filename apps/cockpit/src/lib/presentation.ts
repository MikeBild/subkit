// Production history also contains UUID-shaped references whose version or
// variant nibble is not RFC-conformant. They are still opaque identifiers to a
// reviewer, so presentation must recognise the shape rather than validate the
// identifier format.
const UUID_PATTERN =
  /\b(?:fid_)?(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{1,4}(?:-[0-9a-f]{1,4})?(?:-[0-9a-f]{1,12})?…|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gi;

/**
 * Clip at a word boundary, marking a clipped string with `…`.
 *
 * A clipped line and a wrapped one are different facts, so this happens in the
 * model rather than through `line-clamp`: a reader can tell the text was cut,
 * and whatever renders below is free to say something else. The boundary is
 * preferred, not required — an unbroken run clips hard rather than collapsing
 * to a fragment.
 *
 * Two surfaces clip conversation prose — the chat list's titles and the
 * decision queue's collapsed question — and a second copy of this rule is how
 * they start disagreeing about what a message said.
 */
export function clipAtWord(text: string, max: number): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  const cut = squashed.slice(0, Math.max(1, max - 1));
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

export function hideTechnicalIdentifiers(value: string, replacement: string): string {
  return value.replace(UUID_PATTERN, replacement);
}

export function humanFacingText(value: string, hiddenReferenceLabel: string): string {
  return hideTechnicalIdentifiers(value, hiddenReferenceLabel).replace(/\bsubkit\b/gi, "SubKit");
}

/**
 * One line of readable text from a stored message excerpt.
 *
 * A tool payload is collapsed rather than shown: the engine's excerpt falls
 * back to `JSON.stringify(content)`, so a list row would otherwise print raw
 * tool JSON. `toolLabel` names the action when the payload identifies one —
 * "Listed workflows" rather than the same generic phrase on every such row.
 */
export function conversationExcerpt(
  value: string | null | undefined,
  toolActivityLabel: string,
  hiddenReferenceLabel: string,
  toolLabel?: (toolName: string) => string,
): string {
  const text = humanFacingText(value?.trim() ?? "", hiddenReferenceLabel);
  if (!text) return "";
  const toolPayload = /^\{\s*"tool"\s*:\s*"([a-zA-Z0-9_-]+)"/.exec(text);
  if (toolPayload) {
    const named = toolLabel && toolPayload[1] ? toolLabel(toolPayload[1]) : null;
    return named || toolActivityLabel;
  }
  if (/^\{\s*"tool"\s*:/i.test(text)) return toolActivityLabel;
  return text
    .replace(/\*\*|`{1,3}|#{1,6}\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
