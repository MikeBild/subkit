import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";
import type { TurnEvent } from "./types.ts";

export function serializeEvent(ev: TurnEvent): { event: string; data: string } {
  return { event: ev.type, data: JSON.stringify(ev) };
}

export function toolCallStart(call_id: string, tool: string, input_partial?: unknown): TurnEvent {
  return input_partial === undefined
    ? { type: "tool_call_start", call_id, tool }
    : { type: "tool_call_start", call_id, tool, input_partial };
}

export function toolCallDelta(call_id: string, input_patch: unknown): TurnEvent {
  return { type: "tool_call_delta", call_id, input_patch };
}

export function toolCallEnd(call_id: string, input: unknown): TurnEvent {
  return { type: "tool_call_end", call_id, input };
}

export function toolResult(call_id: string, tool: string, output: unknown): TurnEvent {
  return { type: "tool_result", call_id, tool, output };
}

export function dataPart(data_type: string, payload: unknown): TurnEvent {
  return { type: "data_part", data_type, payload };
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
