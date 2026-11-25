import { logger } from "../../logging/index.ts";
import type { WhisperRequest, WhisperResponse } from "./worker-protocol.ts";

interface Pending {
  readonly resolve: (response: WhisperResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createWhisperWorkerClient(
  createWorker: () => Bun.Worker,
  { timeoutMs = 180_000, maxPending = 4 }: { timeoutMs?: number; maxPending?: number } = {},
) {
  let worker: Bun.Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, Pending>();

  function stop(reason: string): void {
    const stopped = worker;
    worker = null;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, kind: "failed", reason });
    }
    pending.clear();
    stopped?.terminate();
    logger.warn({
      module: "speech",
      action: "local_worker.stopped",
      msg: "local speech worker stopped",
      reason,
    });
  }

  function ensureWorker(): Bun.Worker {
    if (worker) return worker;
    const created = createWorker();
    created.onmessage = ((event: MessageEvent<WhisperResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(event.data.id);
      entry.resolve(event.data);
      if (pending.size === 0) created.unref();
    }) as unknown as Bun.Worker["onmessage"];
    created.onerror = () => stop("worker_error");
    worker = created;
    return created;
  }

  return {
    transcribe(dir: string, samples: Float32Array, language?: string): Promise<WhisperResponse> {
      const id = ++nextId;
      if (pending.size >= maxPending)
        return Promise.resolve({ id, kind: "failed", reason: "busy" });
      const target = ensureWorker();
      return new Promise((resolve) => {
        const timer = setTimeout(() => stop("timeout"), timeoutMs);
        pending.set(id, { resolve, timer });
        target.ref();
        const request: WhisperRequest = { id, kind: "transcribe", dir, samples, language };
        target.postMessage(request);
      });
    },
    close: () => stop("closed"),
  };
}

export type WhisperWorkerClient = ReturnType<typeof createWhisperWorkerClient>;

export const defaultWhisperWorker = (): Bun.Worker =>
  new Worker(
    (Bun as typeof Bun & { isStandaloneExecutable: boolean }).isStandaloneExecutable
      ? "./apps/engine/src/speech/local/whisper-worker.ts"
      : new URL("./whisper-worker.ts", import.meta.url),
    { name: "speech" },
  ) as Bun.Worker;
