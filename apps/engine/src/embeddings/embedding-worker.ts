import { embeddingsAvailable, embedTexts } from "./local-runtime.ts";
import type { EmbeddingRequest, EmbeddingResponse } from "./worker-protocol.ts";

let work = Promise.resolve();
self.onmessage = (event: MessageEvent<EmbeddingRequest>) => {
  const request = event.data;
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
    self.postMessage(response);
  });
};
