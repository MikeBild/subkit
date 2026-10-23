import { z } from "zod";
import { routeLogsToStderr } from "../../logging/logger.ts";
import { preloadQuickJsModule, type RunJsOptions, runJsInCurrentProcess } from "./runtime.ts";
import { SandboxError } from "./types.ts";
import {
  assertBoundedWorkerValue,
  MAX_BINARY_WORKER_WIRE_BYTES,
  MAX_WORKER_MESSAGE_BYTES,
  WORKER_READY_MESSAGE,
} from "./worker-protocol.ts";

const WorkerRequestSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("run_js"),
    opts: z.object({
      code: z.string(),
      input: z.unknown(),
      limits: z
        .object({
          memory_bytes: z.number().int().positive().optional(),
          tick_budget: z.number().int().positive().optional(),
          wall_ms: z.number().int().positive().optional(),
          stack_bytes: z.number().int().positive().optional(),
        })
        .optional(),
      clock: z.object({ now_ms: z.number().finite(), seed: z.string() }).nullable(),
      priority: z.enum(["default", "hook"]).optional(),
    }),
  }),
  z.object({
    op: z.literal("evaluate_jsonata"),
    source: z.string(),
    data: z.unknown(),
    bindings: z.record(z.string(), z.unknown()),
    clock: z.object({ now_ms: z.number().finite(), seed: z.string().optional() }).nullable(),
  }),
  z.object({
    op: z.literal("parse_binary"),
    format: z.enum(["pdf", "docx", "xlsx", "xls", "pptx", "zip", "gzip"]),
    buffer: z.string(),
  }),
]);

export async function runSandboxWorker(): Promise<void> {
  routeLogsToStderr();
  await new Promise<void>((resolve) => {
    process.once("disconnect", resolve);
    process.on("message", (input: unknown) => {
      void handleRequest(input);
    });
    void announceReady();
  });
}

async function announceReady(): Promise<void> {
  try {
    await preloadQuickJsModule();
  } catch {}
  process.send?.(WORKER_READY_MESSAGE);
}

async function handleRequest(input: unknown): Promise<void> {
  const envelope = input as { id?: unknown; body?: unknown } | null;
  const id = envelope?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
  try {
    assertBoundedWorkerValue(envelope?.body, MAX_BINARY_WORKER_WIRE_BYTES);
    const requestBytes = Buffer.byteLength(JSON.stringify(envelope?.body) ?? "");
    if (requestBytes > MAX_BINARY_WORKER_WIRE_BYTES) {
      throw new SandboxError("sandbox worker request exceeds 32 MiB", "marshal");
    }
    const request = WorkerRequestSchema.parse(envelope?.body);
    if (
      request.op === "parse_binary" &&
      Buffer.from(request.buffer, "base64").byteLength > MAX_WORKER_MESSAGE_BYTES
    ) {
      throw new Error("parser input exceeds 32 MiB decoded worker limit");
    }
    const result =
      request.op === "run_js"
        ? await runJsInCurrentProcess(workerRunOptions(request.opts))
        : request.op === "evaluate_jsonata"
          ? await (
              await import("../../execution/jsonata-engine.ts")
            ).evaluateJsonataInCurrentProcess({
              source: request.source,
              data: request.data,
              bindings: request.bindings,
              clock: request.clock
                ? {
                    now_ms: request.clock.now_ms,
                    ...(request.clock.seed ? { seed: request.clock.seed } : {}),
                  }
                : null,
            })
          : request.op === "parse_binary"
            ? await (
                await import("../../docs-ingestion/parsers/index.ts")
              ).parseBinaryFileInCurrentProcess(
                Buffer.from(request.buffer, "base64"),
                request.format,
              )
            : (() => {
                throw new Error("invalid sandbox worker request");
              })();
    writeResponse({ id, ok: true, result });
  } catch (err) {
    const error =
      err instanceof SandboxError
        ? { name: err.name, message: err.message, cause_kind: err.cause_kind, stats: err.stats }
        : {
            name: "SandboxRuntimeError",
            message: err instanceof Error ? err.message : String(err),
            cause_kind: "runtime",
          };
    writeResponse({ id, ok: false, error });
  }
}

function workerRunOptions(opts: {
  code: string;
  input: unknown;
  clock: { now_ms: number; seed: string } | null;
  limits?:
    | {
        memory_bytes?: number | undefined;
        tick_budget?: number | undefined;
        wall_ms?: number | undefined;
        stack_bytes?: number | undefined;
      }
    | undefined;
  priority?: "default" | "hook" | undefined;
}): RunJsOptions {
  const limits = opts.limits;
  return {
    code: opts.code,
    input: opts.input,
    clock: opts.clock,
    ...(limits
      ? {
          limits: {
            ...(limits.memory_bytes !== undefined ? { memory_bytes: limits.memory_bytes } : {}),
            ...(limits.tick_budget !== undefined ? { tick_budget: limits.tick_budget } : {}),
            ...(limits.wall_ms !== undefined ? { wall_ms: limits.wall_ms } : {}),
            ...(limits.stack_bytes !== undefined ? { stack_bytes: limits.stack_bytes } : {}),
          },
        }
      : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
  };
}

function writeResponse(value: {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: unknown;
}): void {
  if (!process.send) throw new Error("sandbox worker IPC is unavailable");
  let oversized = false;
  try {
    assertBoundedWorkerValue(value, MAX_WORKER_MESSAGE_BYTES);
    oversized = Buffer.byteLength(JSON.stringify(value)) > MAX_WORKER_MESSAGE_BYTES;
  } catch {
    oversized = true;
  }
  if (oversized) {
    process.send({
      id: value.id,
      ok: false,
      error: {
        name: "SandboxRuntimeError",
        message: "sandbox worker response exceeds 32 MiB",
        cause_kind: "marshal",
      },
    });
    return;
  }
  process.send(value);
}
