import { transcribeAudio } from "../../llm/index.ts";
import type { CloudTranscriberId } from "../core/order.ts";
import type { TranscribeRequest, Transcriber } from "../port.ts";

export function createCloudTranscriber(id: CloudTranscriberId): Transcriber {
  return {
    id,
    transcribe: (request: TranscribeRequest) =>
      transcribeAudio({
        provider: id,
        tenantId: request.tenantId,
        audio: request.audio,
        model: request.model,
        language: request.language,
        signal: request.signal,
      }),
  };
}
