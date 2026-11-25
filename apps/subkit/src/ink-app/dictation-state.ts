export type DictationPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "recording"; readonly startedAt: number; readonly tool: string }
  | { readonly kind: "transcribing" };

export const IDLE: DictationPhase = { kind: "idle" };

export function dictationInsertText(value: string, cursor: number, transcript: string): string {
  const text = transcript.trim();
  if (!text) return "";
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  return `${lead}${text}${trail}`;
}

export function dictationStatusLine(phase: DictationPhase, now: number): string | null {
  if (phase.kind === "transcribing") return "… writing down what you said";
  if (phase.kind !== "recording") return null;
  const seconds = Math.max(0, Math.floor((now - phase.startedAt) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `● REC ${clock} · Ctrl+D insert · Esc discard`;
}

export function dictationFailure(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "no_speech")
    return "dictation: nothing was heard — try again closer to the microphone";
  if (code === "local_model_missing")
    return "dictation: the server's speech model is still loading — try again in a moment";
  if (code === "speech_off" || code === "speech_unavailable")
    return "dictation: not available in this workspace";
  const message = error instanceof Error ? error.message : String(error);
  return `dictation failed: ${message}`;
}
