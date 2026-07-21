// Lean projection of a finished conversation turn for the MCP client.
//
// PROBLEM (measured, thesis T1): the per-turn `ConversationTurnEnvelope.events`
// is the full LIVE-STREAMING replay log — every `text_delta` token, every
// `tool_call_delta` input patch, the full `tool_call_end.input` (which the
// client itself just SENT) and the full `tool_result.output`. A poll-only MCP
// client (`conversation_get`, `tasks/result`) needs none of that: it needs the
// final assistant message, which tools ran + their outcome, any elicitation,
// and the terminal status. For one turn that ran a workflow with a ~40KB deck
// the raw envelope measured ~125KB and `conversation_get` serialized it TWICE
// (~250KB) — over a default client's 25K-token cap, so the client truncated it
// silently. See conversations/tests/verbosity-evidence.test.ts.
//
// FIX: project the envelope to a lean shape on the way OUT. Persistence and the
// SSE streaming path are untouched — the canonical record stays in
// `conversation_messages` / `conversation_tool_calls`; this only trims the
// poll-return payload. The response SHAPE is preserved (same fields), so no
// client contract changes — only the `events` array gets lean.

import { truncateForLlm } from "../../conversations/tools/truncate.ts";
import type { ConversationTurnEnvelope } from "../tasks/store.ts";

/**
 * Frame types that exist ONLY for live streaming / replay (the SSE surface
 * renders them token-by-token). A poll client cannot use them:
 *   - `text_delta`        → the final `message` frame carries the full text.
 *   - `tool_call_start` / `tool_call_delta` / `tool_call_end`
 *                         → the client SENT the tool input; `tool_result`
 *                           carries the outcome. The echoed input is the single
 *                           biggest contributor (e.g. a 5MB markdown deck).
 *   - `tool_log` / `activity` → progress chatter for a live spinner.
 */
const REPLAY_ONLY_FRAME_TYPES: ReadonlySet<string> = new Set([
  "text_delta",
  "tool_call_start",
  "tool_call_delta",
  "tool_call_end",
  "tool_log",
  "activity",
]);

/** Per-frame cap for any large embedded payload kept in the lean view. The
 *  full payload stays in the engine's canonical tables; a `<field>_raw_ref`
 *  pointer is attached so the model can fetch it via get_raw_result. */
const FRAME_PAYLOAD_CAP = 4_000;

/** Fields that can carry an unbounded payload on a kept frame. */
const TRUNCATABLE_FIELDS = ["output", "payload", "content", "input"] as const;

/**
 * Project a turn's event log to the lean set a poll client needs: drop the
 * replay-only frames, truncate any large payload on the survivors (attaching a
 * raw_ref pointer). Pure + deterministic.
 */
export function projectTurnEventsForClient(events: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const type = (ev as { type?: unknown }).type;
    if (typeof type === "string" && REPLAY_ONLY_FRAME_TYPES.has(type)) continue;

    const frame: Record<string, unknown> = { ...(ev as Record<string, unknown>) };
    for (const key of TRUNCATABLE_FIELDS) {
      if (frame[key] === undefined || frame[key] === null) continue;
      const t = truncateForLlm(frame[key], FRAME_PAYLOAD_CAP);
      if (t.truncated) {
        frame[key] = t.data;
        if (t.raw_ref) frame[`${key}_raw_ref`] = t.raw_ref;
      }
    }
    out.push(frame);
  }
  return out;
}

/**
 * Lean copy of a finished-turn envelope for the MCP client. Same shape, lean
 * `events`. Used by both poll surfaces (`conversation_get`, `tasks/result`).
 */
export function projectTurnEnvelopeForClient(
  env: ConversationTurnEnvelope,
  live?: { pending_elicitation_id: string | null },
): ConversationTurnEnvelope {
  const events = projectTurnEventsForClient(env.events);
  const staleElicitationId =
    live && env.pending_elicitation_id !== live.pending_elicitation_id
      ? env.pending_elicitation_id
      : undefined;
  if (!staleElicitationId) return { ...env, events };

  const reconciledEvents = events.flatMap((event) => {
    if (!event || typeof event !== "object") return [event];
    const frame = event as Record<string, unknown>;
    if (frame.type === "elicit_request" && frame.elicitation_id === staleElicitationId) {
      return [];
    }
    if (frame.type === "next_suggestion") return [];
    if (frame.type === "completed" && frame.status === "awaiting_input") {
      return [{ ...frame, status: "active" }];
    }
    const output = frame.output;
    if (
      frame.type === "tool_result" &&
      output &&
      typeof output === "object" &&
      (output as Record<string, unknown>).elicitation_id === staleElicitationId
    ) {
      return [
        {
          ...frame,
          output: {
            status: "no_longer_pending",
            elicitation_id: staleElicitationId,
            note: "This elicitation is no longer pending. Read the current conversation state before requesting new input.",
          },
        },
      ];
    }
    return [event];
  });
  const { pending_elicitation_id: _retired, ...withoutPending } = env;
  return {
    ...withoutPending,
    status: env.status === "awaiting_input" ? "active" : env.status,
    events: reconciledEvents,
  };
}
