import { expect, test } from "bun:test";
import type { EmbeddingResponse } from "../worker-protocol.ts";

test("embedding worker entry accepts the production availability protocol", async () => {
  const worker = new Worker(new URL("../embedding-worker.ts", import.meta.url));
  try {
    const response = await new Promise<EmbeddingResponse>((resolve, reject) => {
      // allow-wall-clock: watchdog bounds a real Worker response; it does not delay or assert timing.
      const timeout = setTimeout(() => reject(new Error("embedding worker did not reply")), 10_000);
      worker.onmessage = (event: MessageEvent<EmbeddingResponse>) => {
        clearTimeout(timeout);
        resolve(event.data);
      };
      worker.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("embedding worker failed"));
      };
      worker.postMessage({ id: 1, kind: "available" });
    });
    expect(response.id).toBe(1);
    expect(response.kind).toBe("available");
    if (response.kind === "available") expect(typeof response.available).toBe("boolean");
  } finally {
    worker.terminate();
  }
}, 15_000);
