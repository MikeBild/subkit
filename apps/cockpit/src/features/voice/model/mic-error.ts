import type { DictationError } from "./recorder-machine";

export function microphoneError(error: unknown): DictationError {
  const name =
    typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_microphone";
  if (name === "NotReadableError" || name === "AbortError") return "microphone_busy";
  if (name === "TypeError" || name === "NotSupportedError") return "unsupported";
  return "failed";
}

export function transcriptionError(code: string | undefined): DictationError {
  if (code === "no_speech") return "no_speech";
  if (code === "local_model_missing") return "preparing";
  if (code === "speech_unavailable" || code === "speech_off") return "speech_unavailable";
  return "failed";
}

export interface ShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

export function isDictationShortcut(event: ShortcutEvent, isMac: boolean): boolean {
  if (event.repeat || event.isComposing || event.altKey || event.shiftKey) return false;
  if (event.key.toLowerCase() !== "d") return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export const spokenLanguage = (locale: string): string | undefined => {
  const code = locale.slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : undefined;
};
