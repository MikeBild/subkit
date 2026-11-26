export const DICTATION_MAX_MS = 5 * 60 * 1000;

export type DictationError =
  | "permission_denied"
  | "no_microphone"
  | "microphone_busy"
  | "unsupported"
  | "no_speech"
  | "speech_unavailable"
  | "preparing"
  | "failed";

export type DictationState =
  | { readonly phase: "idle"; readonly session: number; readonly error: DictationError | null }
  | { readonly phase: "requesting"; readonly session: number; readonly requestId: string }
  | {
      readonly phase: "recording";
      readonly session: number;
      readonly requestId: string;
      readonly startedAt: number;
      readonly elapsedMs: number;
      readonly level: number;
    }
  | { readonly phase: "transcribing"; readonly session: number; readonly requestId: string };

export type DictationEvent =
  | { readonly type: "start"; readonly requestId: string }
  | { readonly type: "granted"; readonly session: number; readonly now: number }
  | { readonly type: "denied"; readonly session: number; readonly error: DictationError }
  | {
      readonly type: "tick";
      readonly session: number;
      readonly now: number;
      readonly level: number;
    }
  | { readonly type: "stop"; readonly session: number }
  | { readonly type: "transcribed"; readonly session: number }
  | { readonly type: "failed"; readonly session: number; readonly error: DictationError }
  | { readonly type: "cancel" }
  | { readonly type: "dismiss" };

export const initialDictation: DictationState = { phase: "idle", session: 0, error: null };

const idle = (session: number, error: DictationError | null = null): DictationState => ({
  phase: "idle",
  session,
  error,
});

export function dictationReducer(state: DictationState, event: DictationEvent): DictationState {
  if (event.type === "start")
    return state.phase === "idle"
      ? { phase: "requesting", session: state.session + 1, requestId: event.requestId }
      : state;
  if (event.type === "cancel") return state.phase === "idle" ? state : idle(state.session);
  if (event.type === "dismiss") return state.phase === "idle" ? idle(state.session) : state;
  if (event.session !== state.session) return state;
  switch (event.type) {
    case "granted":
      return state.phase === "requesting"
        ? {
            phase: "recording",
            session: state.session,
            requestId: state.requestId,
            startedAt: event.now,
            elapsedMs: 0,
            level: 0,
          }
        : state;
    case "denied":
      return state.phase === "requesting" ? idle(state.session, event.error) : state;
    case "tick":
      return state.phase === "recording"
        ? {
            ...state,
            elapsedMs: Math.max(0, event.now - state.startedAt),
            level: Math.min(1, Math.max(0, event.level)),
          }
        : state;
    case "stop":
      return state.phase === "recording"
        ? { phase: "transcribing", session: state.session, requestId: state.requestId }
        : state;
    case "transcribed":
      return state.phase === "transcribing" ? idle(state.session) : state;
    case "failed":
      return state.phase === "idle" ? state : idle(state.session, event.error);
  }
}

export const reachedLimit = (state: DictationState): boolean =>
  state.phase === "recording" && state.elapsedMs >= DICTATION_MAX_MS;

export const isBusy = (state: DictationState): boolean => state.phase !== "idle";

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
