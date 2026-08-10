const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function hideTechnicalIdentifiers(value: string, replacement: string): string {
  return value.replace(UUID_PATTERN, replacement);
}

export function conversationExcerpt(
  value: string | null | undefined,
  toolActivityLabel: string,
  hiddenReferenceLabel: string,
): string {
  const text = hideTechnicalIdentifiers(value?.trim() ?? "", hiddenReferenceLabel);
  if (!text) return "";
  if (/^\{\s*"tool"\s*:/i.test(text)) return toolActivityLabel;
  return text
    .replace(/\*\*|`{1,3}|#{1,6}\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
