import { stripFileSentinelsForDisplay } from "../files/sentinel.ts";

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

export function truncateExcerpt(text: string, max = 140): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  const budget = Math.max(1, max - 1);
  const clipped = squashed.slice(0, budget);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace * 2 >= budget ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}
