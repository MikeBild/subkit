import { parentPort } from "node:worker_threads";
import { transcribeSamples } from "./whisper-runtime.ts";
import type { WhisperRequest, WhisperResponse } from "./worker-protocol.ts";

const parent = parentPort;
if (!parent) throw new Error("the whisper worker must run as a worker thread");

let work = Promise.resolve();
parent.on("message", (request: WhisperRequest) => {
  work = work.then(async () => {
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
    parent.postMessage(response);
  });
});
