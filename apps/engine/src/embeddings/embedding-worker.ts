import { parentPort } from "node:worker_threads";
import { embeddingsAvailable, embedTexts } from "./local-runtime.ts";
import type { EmbeddingRequest, EmbeddingResponse } from "./worker-protocol.ts";

const parent = parentPort;
if (!parent) throw new Error("the embedding worker must run as a worker thread");

let work = Promise.resolve();
parent.on("message", (request: EmbeddingRequest) => {
  work = work.then(async () => {
    let response: EmbeddingResponse;
    try {
      response =
        request.kind === "available"
          ? { id: request.id, kind: "available", available: await embeddingsAvailable() }
          : { id: request.id, kind: "embed", vectors: await embedTexts(request.texts) };
    } catch {
      response = { id: request.id, kind: "failed" };
    }
    parent.postMessage(response);
  });
});
