import { SPEECH_MAX_TRANSCRIPT_CHARS } from "./limits.ts";

export type TranscriptOutcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "no_speech" };

const NON_SPEECH =
  /^[\s.…\-–—]*(\[(blank_audio|silence|music|no speech)\]|\((silence|music)\))?[\s.…\-–—]*$/i;

export function finalTranscript(raw: string): TranscriptOutcome {
  const text = raw.replace(/\s+/g, " ").trim().slice(0, SPEECH_MAX_TRANSCRIPT_CHARS);
  return text.length === 0 || NON_SPEECH.test(text)
    ? { kind: "no_speech" }
    : { kind: "text", text };
}
