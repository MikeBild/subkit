import { envFlag } from "../env.ts";
import { logger } from "../logging/index.ts";
import type { EmbeddingRequest, EmbeddingResponse } from "./worker-protocol.ts";

interface Pending {
  message: EmbeddingRequest;
  resolve: (response: EmbeddingResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createEmbeddingWorkerClient(
  createWorker: () => Bun.Worker,
  { maxPending = 64, timeoutMs = 120_000 }: { maxPending?: number; timeoutMs?: number } = {},
) {
  let worker: Bun.Worker | null = null;
  let unavailable = false;
  let ready = false;
  let nextId = 0;
  const pending = new Map<number, Pending>();

  function failWorker(): void {
    if (unavailable) return;
    unavailable = true;
    const stopped = worker;
    worker = null;
    ready = false;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, kind: "failed" });
    }
    pending.clear();
    stopped?.terminate();
    logger.warn({
      module: "embeddings",
      action: "worker.unavailable",
      msg: "Embedding worker unavailable; retrieval falls back to FTS",
    });
  }

  function getWorker(): Bun.Worker | null {
    if (unavailable) return null;
    if (worker) return worker;
    try {
      worker = createWorker();
      worker.addEventListener("open", () => {
        ready = true;
        try {
          for (const entry of pending.values()) worker?.postMessage(entry.message);
        } catch {
          failWorker();
        }
      });
      const onMessage = (event: MessageEvent<EmbeddingResponse>) => {
        const response = event.data;
        const entry = pending.get(response.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(response.id);
        entry.resolve(response);
        if (pending.size === 0) worker?.unref();
      };

      worker.onmessage = onMessage as unknown as Bun.Worker["onmessage"];
      worker.onerror = () => failWorker();
      worker.addEventListener("close", () => failWorker());
      return worker;
    } catch {
      failWorker();
      return null;
    }
  }

  async function request(message: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (pending.size >= maxPending) return { id: message.id, kind: "failed" };
    const target = getWorker();
    if (!target) return { id: message.id, kind: "failed" };
    return new Promise((resolve) => {
      const timer = setTimeout(failWorker, timeoutMs);
      pending.set(message.id, { message, resolve, timer });
      target.ref();
      try {
        if (ready) target.postMessage(message);
      } catch {
        failWorker();
      }
    });
  }

  return {
    async available(): Promise<boolean> {
      const response = await request({ id: ++nextId, kind: "available" });
      return response.kind === "available" && response.available;
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const response = await request({
        id: ++nextId,
        kind: "embed",
        texts: texts.map((text) => text.slice(0, 8192)),
      });
      return response.kind === "embed" ? response.vectors : [];
    },
    close: failWorker,
  };
}

const client = createEmbeddingWorkerClient(
  () =>
    new Worker(
      (Bun as typeof Bun & { isStandaloneExecutable: boolean }).isStandaloneExecutable
        ? "./apps/engine/src/embeddings/embedding-worker.ts"
        : new URL("./embedding-worker.ts", import.meta.url),
      { name: "embeddings" },
    ) as Bun.Worker,
);

function diagnosticInline(): boolean {
  return envFlag("SUBKIT_DIAGNOSTICS") && envFlag("SUBKIT_DIAGNOSTICS_EMBEDDING_INLINE");
}

export async function workerEmbeddingsAvailable(): Promise<boolean> {
  if (diagnosticInline()) return (await import("./local-runtime.ts")).embeddingsAvailable();
  return client.available();
}

export async function workerEmbedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (diagnosticInline()) return (await import("./local-runtime.ts")).embedTexts(texts);
  return client.embed(texts);
}
