export type BubbleSide = "answer" | "subkit" | "system";

export function bubbleSide(role: string): BubbleSide {
  if (role === "user") return "answer";
  if (role === "assistant") return "subkit";
  return "system";
}

export function bubbleContinues(previous: BubbleSide | null, current: BubbleSide): boolean {
  return previous !== null && previous === current && current !== "system";
}

export interface SpokenEntry {
  role: string;
  spoke: boolean;
}

export function previousSides(entries: readonly SpokenEntry[]): (BubbleSide | null)[] {
  return entries.map((_, index) => {
    const entry = index > 0 ? entries[index - 1] : undefined;
    return entry?.spoke ? bubbleSide(entry.role) : null;
  });
}

export type AnswerPhase = "none" | "waiting" | "streaming";

export function answerPhase(input: {
  sendPending: boolean;
  streamedText: string;
  liveCalls: number;
}): AnswerPhase {
  if (input.streamedText) return "streaming";
  if (input.sendPending && input.liveCalls === 0) return "waiting";
  return "none";
}
