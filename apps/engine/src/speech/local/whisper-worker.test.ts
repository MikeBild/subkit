import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WhisperResponse } from "./worker-protocol.ts";

test("whisper worker entry answers the production protocol with a correlated failure when the model is absent", async () => {
  const worker = new Worker(new URL("./whisper-worker.ts", import.meta.url));
  try {
    const response = await new Promise<WhisperResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WhisperResponse>) => resolve(event.data);
      worker.onerror = () => reject(new Error("whisper worker failed"));
      worker.postMessage({
        id: 7,
        kind: "transcribe",
        dir: join(tmpdir(), "subkit-speech-model-absent"),
        samples: new Float32Array(160),
      });
    });
    expect(response.id).toBe(7);
    expect(response.kind).toBe("failed");
  } finally {
    worker.terminate();
  }
}, 60_000);
