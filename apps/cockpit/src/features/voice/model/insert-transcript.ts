export interface TextSelection {
  readonly start: number;
  readonly end: number;
}

export interface Inserted {
  readonly value: string;
  readonly caret: number;
}

const needsSpaceBefore = (before: string): boolean => before.length > 0 && !/\s$/.test(before);
const needsSpaceAfter = (after: string, transcript: string): boolean =>
  after.length > 0 && !/^[\s.,;:!?)]/.test(after) && !/\s$/.test(transcript);

export function insertTranscript(
  value: string,
  selection: TextSelection | null,
  transcript: string,
): Inserted {
  const text = transcript.trim();
  if (!text) return { value, caret: selection?.end ?? value.length };
  const start = Math.max(0, Math.min(selection?.start ?? value.length, value.length));
  const end = Math.max(start, Math.min(selection?.end ?? value.length, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const piece = `${needsSpaceBefore(before) ? " " : ""}${text}${needsSpaceAfter(after, text) ? " " : ""}`;
  return { value: `${before}${piece}${after}`, caret: before.length + piece.length };
}
