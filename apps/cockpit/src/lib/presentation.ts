const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function hideTechnicalIdentifiers(value: string, replacement: string): string {
  return value.replace(UUID_PATTERN, replacement);
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
  const text = hideTechnicalIdentifiers(value?.trim() ?? "", hiddenReferenceLabel);
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
