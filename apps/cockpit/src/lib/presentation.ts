const UUID_PATTERN =
  /\b(?:fid_)?(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{1,4}(?:-[0-9a-f]{1,4})?(?:-[0-9a-f]{1,12})?…|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gi;

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
