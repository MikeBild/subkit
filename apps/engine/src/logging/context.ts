import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Structured context carried by every log line. Populated at the HTTP edge,
 * chat-event edge, queue worker edge, and webhook verifier edge.
 */
export type LogContext = {
  trace_id?: string;
  tenant_id?: string;
  execution_id?: string;
  workflow_id?: string;
  request_source?: "api" | "cli" | "scheduler" | "mcp" | "webhook" | "tool-chain" | "ui" | "chat";
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

/**
 * Generate a short-ish trace id. Not cryptographically significant, just
 * needs to be collision-resistant within a request burst. Uses Bun / Node
 * built-in `crypto.randomUUID` and strips to 12 hex chars for compact logs.
 */
export function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
