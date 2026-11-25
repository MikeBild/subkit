import { logger } from "../logging/index.ts";
import type { LocalModelState } from "./core/model-files.ts";
import {
  CLOUD_TRANSCRIBERS,
  type CloudTranscriberId,
  type TranscriberId,
  type TranscriptionPreference,
  transcriberOrder,
} from "./core/order.ts";
import { finalTranscript } from "./core/transcript.ts";
import { SpeechError, type TranscribeRequest, type Transcriber } from "./port.ts";

const PREFERENCES: readonly TranscriptionPreference[] = [
  "auto",
  "off",
  "local",
  ...CLOUD_TRANSCRIBERS,
];

export const parsePreference = (value: string | undefined): TranscriptionPreference =>
  PREFERENCES.find((preference) => preference === value) ?? "auto";

export interface SpeechSettings {
  readonly preference: TranscriptionPreference;
  readonly model: string | undefined;
  readonly primaryProvider: string;
}

export interface SpeechServiceDeps {
  settings(tenantId: string): SpeechSettings;
  configured(id: CloudTranscriberId, tenantId: string): boolean;
  readonly transcribers: Readonly<Record<TranscriberId, Transcriber>>;
  readonly local: {
    state(): Promise<LocalModelState>;
    prepare(): Promise<LocalModelState>;
  };
  readonly clock: () => number;
}

export interface SpeechStatus {
  readonly available: boolean;
  readonly preference: TranscriptionPreference;
  readonly transcribers: readonly TranscriberId[];
  readonly local_model: LocalModelState;
  readonly needs_prepare: boolean;
}

export interface Transcription {
  readonly text: string;
  readonly transcriber: TranscriberId;
  readonly duration_ms: number;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createSpeechService(deps: SpeechServiceDeps) {
  const orderFor = (tenantId: string) => {
    const settings = deps.settings(tenantId);
    const configured = Object.fromEntries(
      CLOUD_TRANSCRIBERS.map((id) => [id, deps.configured(id, tenantId)]),
    ) as Record<CloudTranscriberId, boolean>;
    return {
      settings,
      order: transcriberOrder(settings.preference, {
        primaryProvider: settings.primaryProvider,
        configured,
        localAllowed: true,
      }),
    };
  };

  async function status(tenantId: string): Promise<SpeechStatus> {
    const { settings, order } = orderFor(tenantId);
    const local_model = await deps.local.state();
    return {
      available: order.length > 0,
      preference: settings.preference,
      transcribers: order,
      local_model,
      needs_prepare: order.length === 1 && order[0] === "local" && local_model.kind !== "ready",
    };
  }

  async function transcribe(request: TranscribeRequest): Promise<Transcription> {
    const { settings, order } = orderFor(request.tenantId);
    if (order.length === 0)
      throw new SpeechError(
        settings.preference === "off" ? "speech_off" : "speech_unavailable",
        settings.preference === "off"
          ? "voice dictation is turned off for this workspace"
          : "no speech-to-text service is available",
      );
    const failures: SpeechError[] = [];
    for (const id of order) {
      const started = deps.clock();
      logger.info({
        module: "speech",
        action: "transcribe.start",
        msg: "transcribing a recording",
        tenant_id: request.tenantId,
        transcriber: id,
        bytes: request.audio.byteLength,
        content_type: request.contentType,
      });
      try {
        const raw = await deps.transcribers[id].transcribe({
          ...request,
          model: id === "local" ? undefined : settings.model,
        });
        const outcome = finalTranscript(raw);
        const duration_ms = deps.clock() - started;
        logger.info({
          module: "speech",
          action: "transcribe.done",
          msg: "recording transcribed",
          tenant_id: request.tenantId,
          transcriber: id,
          duration_ms,
          chars: outcome.kind === "text" ? outcome.text.length : 0,
        });
        if (outcome.kind === "no_speech")
          throw new SpeechError("no_speech", "no speech was recognized in the recording", id);
        return { text: outcome.text, transcriber: id, duration_ms };
      } catch (error) {
        if (error instanceof SpeechError && error.code === "no_speech") throw error;
        if (request.signal?.aborted) throw error;
        const failure =
          error instanceof SpeechError
            ? error
            : new SpeechError(
                "transcription_failed",
                `${id} transcription failed: ${errorText(error)}`,
                id,
              );
        failures.push(failure);
        logger.warn({
          module: "speech",
          action: "transcribe.failed",
          msg: "transcriber failed; trying the next one",
          tenant_id: request.tenantId,
          transcriber: id,
          code: failure.code,
          error: failure.message,
          duration_ms: deps.clock() - started,
        });
      }
    }
    throw (
      failures.at(-1) ??
      new SpeechError("speech_unavailable", "no speech-to-text service is available")
    );
  }

  return { status, transcribe, prepare: () => deps.local.prepare() };
}

export type SpeechService = ReturnType<typeof createSpeechService>;
