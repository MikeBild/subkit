import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";
import type { TurnEvent } from "./types.ts";

export function serializeEvent(ev: TurnEvent): { event: string; data: string } {
  return { event: ev.type, data: JSON.stringify(ev) };
}

export function toolResult(call_id: string, tool: string, output: unknown): TurnEvent {
  return { type: "tool_result", call_id, tool, output };
}

export function nextSuggestion(args: {
  suggestion: string | null;
  reason: SuggestNextReason;
  kind: SuggestNextKind | null;
}): TurnEvent {
  return {
    type: "next_suggestion",
    suggestion: args.suggestion,
    reason: args.reason,
    kind: args.kind,
  };
}
