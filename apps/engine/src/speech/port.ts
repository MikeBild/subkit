import type { LocalModelState } from "./core/model-files.ts";
import type { TranscriberId } from "./core/order.ts";

export interface TranscribeRequest {
  readonly tenantId: string;
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly model?: string | undefined;
  readonly language?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface Transcriber {
  readonly id: TranscriberId;
  transcribe(request: TranscribeRequest): Promise<string>;
}

export interface LocalSpeechControls {
  state(): LocalModelState;
  prepare(): Promise<LocalModelState>;
}

export type SpeechErrorCode =
  | "speech_off"
  | "speech_unavailable"
  | "no_speech"
  | "transcription_failed"
  | "local_model_missing"
  | "local_needs_wav";

const STATUS: Record<SpeechErrorCode, 409 | 422 | 502> = {
  speech_off: 409,
  speech_unavailable: 409,
  no_speech: 422,
  transcription_failed: 502,
  local_model_missing: 409,
  local_needs_wav: 422,
};

export class SpeechError extends Error {
  readonly status: 409 | 422 | 502;
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
    readonly transcriber?: TranscriberId,
  ) {
    super(message);
    this.name = "SpeechError";
    this.status = STATUS[code];
  }
}
