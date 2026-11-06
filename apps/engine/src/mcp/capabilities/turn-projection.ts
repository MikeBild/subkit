import { truncateForLlm } from "../../tools/truncate.ts";
import type { ConversationTurnEnvelope } from "../tasks/store.ts";

const REPLAY_ONLY_FRAME_TYPES: ReadonlySet<string> = new Set([
  "text_delta",
  "tool_call_start",
  "tool_call_delta",
  "tool_call_end",
  "tool_log",
  "activity",
]);

const FRAME_PAYLOAD_CAP = 4_000;

const TRUNCATABLE_FIELDS = ["output", "payload", "content", "input"] as const;

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
