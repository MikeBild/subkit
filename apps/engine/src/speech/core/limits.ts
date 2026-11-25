export const SPEECH_MAX_BYTES = 25 * 1024 * 1024;
export const SPEECH_MAX_TRANSCRIPT_CHARS = 100_000;

export const SPEECH_CONTENT_TYPES = [
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
] as const;

export type SpeechContentType = (typeof SPEECH_CONTENT_TYPES)[number];

export type AudioRefusal =
  | { readonly code: "unsupported_audio"; readonly status: 422; readonly message: string }
  | { readonly code: "audio_too_large"; readonly status: 413; readonly message: string }
  | { readonly code: "audio_empty"; readonly status: 400; readonly message: string };

export const baseContentType = (contentType: string): string =>
  (contentType.split(";")[0] ?? "").trim().toLowerCase().replace("audio/x-wav", "audio/wav");

export const isSpeechContentType = (contentType: string): contentType is SpeechContentType =>
  (SPEECH_CONTENT_TYPES as readonly string[]).includes(contentType);

export function audioRefusal(contentType: string, byteLength: number): AudioRefusal | null {
  if (!isSpeechContentType(baseContentType(contentType)))
    return {
      code: "unsupported_audio",
      status: 422,
      message: `audio type ${contentType} is not supported; send ${SPEECH_CONTENT_TYPES.join(", ")}`,
    };
  if (byteLength === 0)
    return { code: "audio_empty", status: 400, message: "the recording is empty" };
  if (byteLength > SPEECH_MAX_BYTES)
    return {
      code: "audio_too_large",
      status: 413,
      message: `the recording exceeds ${SPEECH_MAX_BYTES} bytes`,
    };
  return null;
}
