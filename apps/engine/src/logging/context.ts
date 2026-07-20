import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Structured context carried by every log line. Populated at the HTTP edge,
 * chat-event edge, queue worker edge, and webhook verifier edge.
 */
export type LogContext = {
  trace_id?: string;
  /** W3C server span id for the current execution edge. */
  span_id?: string;
  tenant_id?: string;
  execution_id?: string;
  workflow_id?: string;
  request_source?:
    | "api"
    | "cli"
    | "scheduler"
    | "mcp"
    | "webhook"
    | "tool-chain"
    | "ui"
    | "chat"
    | "queue";
  actor_id?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged: LogContext = { ...(storage.getStore() ?? {}), ...ctx };
  return storage.run(merged, fn);
}

export function getContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Legacy non-W3C helper retained for queue/CLI contexts. HTTP edges use a
 * full 128-bit W3C trace id in traceMiddleware. */
export function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
