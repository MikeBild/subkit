import { readLlmSetting } from "../llm/runtime/model-init.ts";
import { createModelStore } from "./local/model-store.ts";
import { createWhisperWorkerClient, defaultWhisperWorker } from "./local/whisper-client.ts";
import { cloudTranscriberConfigured, createCloudTranscriber } from "./providers/cloud.ts";
import { createLocalTranscriber } from "./providers/local.ts";
import { createSpeechService, parsePreference, type SpeechService } from "./service.ts";

export { audioRefusal, SPEECH_CONTENT_TYPES, SPEECH_MAX_BYTES } from "./core/limits.ts";
export type { LocalModelState } from "./core/model-files.ts";
export type { TranscriberId } from "./core/order.ts";
export { SpeechError, type SpeechErrorCode } from "./port.ts";
export type { SpeechService, SpeechStatus, Transcription } from "./service.ts";

function createDefaultSpeechService(): SpeechService {
  const store = createModelStore();
  const client = createWhisperWorkerClient(defaultWhisperWorker);
  return createSpeechService({
    settings: (tenantId) => ({
      preference: parsePreference(readLlmSetting("TRANSCRIPTION_PROVIDER", tenantId)),
      model: readLlmSetting("TRANSCRIPTION_MODEL", tenantId),
      primaryProvider: readLlmSetting("LLM_PROVIDER", tenantId) ?? "",
    }),
    configured: cloudTranscriberConfigured,
    transcribers: {
      openai: createCloudTranscriber("openai"),
      azure: createCloudTranscriber("azure"),
      gemini: createCloudTranscriber("gemini"),
      local: createLocalTranscriber(store, client),
    },
    local: store,
    clock: Date.now,
  });
}

let speechService: SpeechService | null = null;

export const getSpeechService = (): SpeechService => {
  speechService ??= createDefaultSpeechService();
  return speechService;
};

export function setSpeechServiceForTests(next: SpeechService | null): void {
  speechService = next;
}
