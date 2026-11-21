import type { TranslationKey } from "@/lib/i18n";

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

export type ChatMode = "ask" | "auto" | "plan";

export const MODE_ORDER: readonly ChatMode[] = ["ask", "auto", "plan"];

export function modeHintKey(mode: ChatMode): TranslationKey {
  return `chat.mode.hint.${mode}`;
}

export function turnMode(input: {
  existing: boolean;
  picked: ChatMode;
  switched: ChatMode | null;
}): ChatMode | null {
  return input.existing ? input.switched : input.picked;
}

export function switchedOrDefault(input: {
  switched: ChatMode | null;
  stored: ChatMode | "yolo" | "unset" | "loading";
  fallback: ChatMode;
}): ChatMode | null {
  return input.switched ?? (input.stored === "unset" ? input.fallback : null);
}

export function shownMode(input: {
  existing: boolean;
  picked: ChatMode;
  switched: ChatMode | null;
  stored: ChatMode | null;
  sent: ChatMode | null;
}): ChatMode | null {
  if (!input.existing) return input.picked;
  return input.switched ?? input.stored ?? input.sent;
}
