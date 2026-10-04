export interface LiveCall {
  callId: string;
  toolName: string | null;
  startedAt: number;
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

export function elapsedMs(call: LiveCall, now: number): number | null {
  if (call.done) return null;
  return Math.max(0, now - call.startedAt);
}
