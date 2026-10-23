import {
  SandboxError,
  SandboxInterruptError,
  SandboxMemoryError,
  SandboxRuntimeError,
  type SandboxStats,
  SandboxStdlibInitError,
  SandboxSyntaxError,
  SandboxTimeoutError,
} from "./types.ts";

export interface WorkerFailure {
  name: string;
  message: string;
  cause_kind?: SandboxError["cause_kind"];
  stats?: SandboxStats;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: WorkerFailure;
}

export const MAX_WORKER_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_BINARY_WORKER_WIRE_BYTES = 45 * 1024 * 1024;
export const WORKER_READY_MESSAGE = { ready: true } as const;

export function isReadyMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { ready?: unknown }).ready === true &&
    !("id" in message)
  );
}

export type WorkerResetReason =
  | "rss_exceeded"
  | "rss_recycle"
  | "deadline_exceeded"
  | "aborted"
  | "marshal"
  | "memory"
  | "timeout"
  | "stdlib_init"
  | "worker_exited"
  | "invalid_response"
  | "spawn_failed"
  | "spawn_timeout"
  | "closed";

const KEEP_ALIVE_CAUSES: ReadonlySet<SandboxError["cause_kind"]> = new Set([
  "runtime",
  "syntax",
  "interrupt",
]);

export function workerFailureResetReason(
  error: Pick<WorkerFailure, "cause_kind"> | undefined,
): WorkerResetReason | null {
  const cause = error?.cause_kind ?? "runtime";
  if (KEEP_ALIVE_CAUSES.has(cause)) return null;
  switch (cause) {
    case "memory":
      return "memory";
    case "timeout":
      return "timeout";
    case "marshal":
      return "marshal";
    default:
      return "stdlib_init";
  }
}

export class WorkerTransportError extends Error {
  constructor(
    message: string,
    readonly reason: WorkerResetReason,
  ) {
    super(message);
    this.name = "WorkerTransportError";
  }
}

export function assertBoundedWorkerValue(value: unknown, maxBytes: number): void {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const active = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  const measureString = (input: string): number => {
    let size = Buffer.byteLength(input) + 2;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        size += 1;
      else if (code < 32) size += 5;
    }
    return size;
  };
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    if (next.exit) {
      active.delete(next.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > 1_000_000 || next.depth > 512) {
      throw new SandboxError("sandbox worker request is too complex", "marshal");
    }
    const current = next.value;
    if (typeof current === "string") bytes += measureString(current);
    else if (typeof current === "number" || typeof current === "boolean")
      bytes += String(current).length;
    else if (current === null || current === undefined) bytes += 4;
    else if (typeof current === "object") {
      if (active.has(current))
        throw new SandboxError("sandbox worker request is cyclic", "marshal");
      active.add(current);
      stack.push({ value: current, depth: next.depth, exit: true });
      if (Array.isArray(current)) {
        bytes += current.length + 1;
        for (const entry of current) stack.push({ value: entry, depth: next.depth + 1 });
      } else {
        const entries = Object.entries(current);
        bytes += entries.length + 1;
        for (const [key, entry] of entries) {
          bytes += measureString(key) + 1;
          stack.push({ value: entry, depth: next.depth + 1 });
        }
      }
    } else throw new SandboxError("sandbox worker request is not JSON-compatible", "marshal");
    if (bytes > maxBytes)
      throw new SandboxError("sandbox worker request exceeds 32 MiB", "marshal");
  }
}

export function workerError(error: WorkerFailure | undefined): SandboxError {
  const message = error?.message ?? "sandbox worker returned no result";
  switch (error?.cause_kind) {
    case "memory":
      return new SandboxMemoryError(message, error.stats);
    case "interrupt":
      return new SandboxInterruptError(message, error.stats);
    case "timeout":
      return new SandboxTimeoutError(message, error.stats);
    case "syntax":
      return new SandboxSyntaxError(message, error.stats);
    case "stdlib_init":
      return new SandboxStdlibInitError(message, error.stats);
    case "marshal":
      return new SandboxError(message, "marshal", error.stats);
    default:
      return new SandboxRuntimeError(message, error?.stats);
  }
}
