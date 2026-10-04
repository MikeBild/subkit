const CLOSING_ASK_MAX_CHARS = 600;

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
