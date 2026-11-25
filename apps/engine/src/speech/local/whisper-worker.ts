import { parentPort } from "node:worker_threads";
import { transcribeSamples } from "./whisper-runtime.ts";
import type { WhisperRequest, WhisperResponse } from "./worker-protocol.ts";

const parent = parentPort;
if (!parent) throw new Error("the whisper worker must run as a worker thread");
const port = parent;

async function answer(request: WhisperRequest): Promise<void> {
  let response: WhisperResponse;
  try {
    response = {
      id: request.id,
      kind: "text",
      text: await transcribeSamples(request.dir, request.samples, request.language),
    };
  } catch (error) {
    response = {
      id: request.id,
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
}

let work = Promise.resolve();
port.on("message", (request: WhisperRequest) => {
  const previous = work;
  work = (async () => {
    await previous;
    await answer(request);
  })();
});
