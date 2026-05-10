// Turn an in-progress conversation loop run into an AsyncIterable
// of `TurnEvent` frames for the SSE route.
//
// v1 strategy: run the loop to completion up-front, then yield the
// cached event list. This matches the rest of the P10 surface where
// the loop is deterministic and bounded, and keeps the HTTP route
// implementation dead simple. A later phase can swap in a push-based
// EventEmitter when the real streaming SDK lands.

import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";
import type { RunLoopResult } from "./loop.ts";
import type { TurnEvent } from "./types.ts";

export async function* replayEvents(result: RunLoopResult): AsyncIterable<TurnEvent> {
  for (const ev of result.events) {
    yield ev;
  }
}

export function serializeEvent(ev: TurnEvent): { event: string; data: string } {
  return { event: ev.type, data: JSON.stringify(ev) };
}

// Lifecycle + data-part builders. These are stateless helpers the loop
// calls to push new-style frames; they mirror the AI SDK UI wire model
// without imposing a specific transport.

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

/**
 * Emit an application-defined data part. `data_type` is an opaque
 * tag the client's `DataPartRegistry` dispatches on
 * (`data-progress`, `data-skill-candidate`, `data-connector-docs`,
 * etc). Mirrors Vercel AI SDK UI's `data-*` part convention.
 */
export function dataPart(data_type: string, payload: unknown): TurnEvent {
  return { type: "data_part", data_type, payload };
}

/**
 * Frame builder for the next-message suggestion. The loop calls this
 * after the assistant's terminal `message` event and before the SSE
 * `outcome` envelope so the client can paint ghost text in the input
 * composer for the operator's next turn.
 */
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
