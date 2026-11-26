import type { Executor } from "../db/index.ts";
import type { LocalModelState } from "./core/model-files.ts";
import type { CloudTranscriberId, TranscriberId } from "./core/order.ts";

export interface SpeechActor {
  readonly user_id: string | null;
  readonly actor_type: "user" | "system_account" | "system";
}

export interface TranscribeRequest {
  readonly tenantId: string;
  readonly clientRequestId: string;
  readonly db: Executor;
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly model?: string | undefined;
  readonly language?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly actor?: SpeechActor | undefined;
}

export interface TranscriberOutput {
  readonly text: string;
  readonly model?: string | undefined;
  readonly audio_seconds?: number | undefined;
}

export interface Transcriber {
  readonly id: TranscriberId;
  transcribe(request: TranscribeRequest): Promise<TranscriberOutput>;
}

export type TranscriptionKeyOwner = "workspace" | "operator";

export interface TranscriptionLedgerKey {
  readonly tenantId: string;
  readonly clientRequestId: string;
  readonly db: Executor;
}

export type PriorTranscription =
  | { readonly kind: "fresh" | "in_progress" | "unsettled" }
  | {
      readonly kind: "replay";
      readonly text: string;
      readonly transcriber: CloudTranscriberId;
      readonly latency_ms: number;
    };

export type TranscriptionReservation =
  | PriorTranscription
  | { readonly kind: "reserved" }
  | { readonly kind: "spend_limit" };

export interface TranscriptionLedger {
  prior(key: TranscriptionLedgerKey): Promise<PriorTranscription>;
  reserve(
    input: TranscriptionLedgerKey & {
      readonly transcriber: CloudTranscriberId;
      readonly model: string | undefined;
      readonly estimateSeconds: number;
      readonly actor: SpeechActor | undefined;
    },
  ): Promise<TranscriptionReservation>;
  settle(
    input: TranscriptionLedgerKey & {
      readonly transcriber: CloudTranscriberId;
      readonly model: string | undefined;
      readonly audioSeconds: number;
      readonly latencyMs: number;
      readonly transcript: string;
    },
  ): Promise<boolean>;
  release(input: TranscriptionLedgerKey & { readonly latencyMs: number }): Promise<boolean>;
  reconcile(input: TranscriptionLedgerKey & { readonly latencyMs: number }): Promise<boolean>;
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
  | "local_needs_wav"
  | "transcription_in_progress"
  | "transcription_unsettled";

const STATUS: Record<SpeechErrorCode, 409 | 422 | 502> = {
  speech_off: 409,
  speech_unavailable: 409,
  no_speech: 422,
  transcription_failed: 502,
  local_model_missing: 409,
  local_needs_wav: 422,
  transcription_in_progress: 409,
  transcription_unsettled: 409,
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
