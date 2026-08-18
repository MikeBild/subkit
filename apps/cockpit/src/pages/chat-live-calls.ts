// What a governed action is doing right now.
//
// The engine has always streamed `tool_call_start`, `tool_log`, `tool_call_end`
// and `tool_result` over SSE. The chat page handled `text_delta` and `diff` and
// dropped the rest, so a call that took two minutes showed nothing at all while
// it ran — and the only thing on screen was a card that said it was pending.
//
// None of this survives a reload, and it must not pretend to: no per-call
// duration is persisted anywhere. A reloaded transcript shows no timer rather
// than a fabricated one.

export interface LiveCall {
  callId: string;
  toolName: string | null;
  /** Client clock, from the frame that announced the call. */
  startedAt: number;
  /** The most recent log line the engine emitted for this call. */
  logTail: string | null;
  done: boolean;
}

export type LiveCallEvent =
  | { kind: "start"; callId: string; toolName: string | null; at: number }
  | { kind: "log"; callId: string; message: string }
  | { kind: "end"; callId: string };

function stringField(event: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = event[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Read one SSE frame as a live-call event, or null when it is not one. */
export function reduceLiveCall(
  event: { type: string; [key: string]: unknown },
  now: number = Date.now(),
): LiveCallEvent | null {
  const callId = stringField(event, "call_id", "tool_call_id", "id");
  if (!callId) return null;
  if (event.type === "tool_call_start") {
    return { kind: "start", callId, toolName: stringField(event, "tool", "tool_name"), at: now };
  }
  if (event.type === "tool_log") {
    const message = stringField(event, "message", "text");
    return message ? { kind: "log", callId, message } : null;
  }
  if (event.type === "tool_call_end" || event.type === "tool_result") {
    return { kind: "end", callId };
  }
  return null;
}

/** Fold one event into the running list, preserving arrival order. */
export function applyLiveCall(calls: readonly LiveCall[], event: LiveCallEvent): LiveCall[] {
  const index = calls.findIndex((call) => call.callId === event.callId);
  if (event.kind === "start") {
    if (index >= 0) return [...calls];
    return [
      ...calls,
      {
        callId: event.callId,
        toolName: event.toolName,
        startedAt: event.at,
        logTail: null,
        done: false,
      },
    ];
  }
  // A log or an end for a call we never saw start is not an error — the stream
  // can be joined late. Dropping it would lose the only evidence the call
  // exists, so it is recorded as an already-finished entry rather than ignored.
  if (index < 0) {
    if (event.kind === "end") return [...calls];
    return [...calls];
  }
  const existing = calls[index];
  if (!existing) return [...calls];
  const updated: LiveCall =
    event.kind === "log" ? { ...existing, logTail: event.message } : { ...existing, done: true };
  const next = [...calls];
  next[index] = updated;
  return next;
}

/** How long a call has been running, or null once it has finished. */
export function elapsedMs(call: LiveCall, now: number): number | null {
  if (call.done) return null;
  return Math.max(0, now - call.startedAt);
}
