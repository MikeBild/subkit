import { baseContentType } from "../core/limits.ts";
import { decodePcmWav, resampleLinear } from "../core/wav.ts";
import type { ModelStore } from "../local/model-store.ts";
import type { WhisperWorkerClient } from "../local/whisper-client.ts";
import {
  SpeechError,
  type TranscribeRequest,
  type Transcriber,
  type TranscriberOutput,
} from "../port.ts";

const WHISPER_SAMPLE_RATE = 16_000;

export function createLocalTranscriber(
  store: ModelStore,
  client: WhisperWorkerClient,
): Transcriber {
  return {
    id: "local",
    async transcribe(request: TranscribeRequest): Promise<TranscriberOutput> {
      if (baseContentType(request.contentType) !== "audio/wav")
        throw new SpeechError(
          "local_needs_wav",
          "the local speech model needs a WAV recording",
          "local",
        );
      if ((await store.state()).kind !== "ready")
        throw new SpeechError(
          "local_model_missing",
          "the local speech model is not downloaded yet; prepare it first",
          "local",
        );
      const decoded = decodePcmWav(request.audio);
      if (!decoded.ok)
        throw new SpeechError("local_needs_wav", `the WAV recording is ${decoded.reason}`, "local");
      const response = await client.transcribe(
        store.dir,
        resampleLinear(decoded.audio, WHISPER_SAMPLE_RATE),
        request.language,
      );
      if (response.kind === "failed")
        throw new SpeechError(
          "transcription_failed",
          `local transcription failed: ${response.reason}`,
          "local",
        );
      return { text: response.text };
    },
  };
}
