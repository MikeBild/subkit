import { AsyncLocalStorage } from "node:async_hooks";

export type LogContext = {
  execution_privacy?: "sensitive" | undefined;
  trace_id?: string;
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
  auth_via?: "token_exchange" | undefined;
};

const storage = new AsyncLocalStorage<LogContext>();

export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged: LogContext = { ...(storage.getStore() ?? {}), ...ctx };
  return storage.run(merged, fn);
}

export function getContext(): LogContext {
  return storage.getStore() ?? {};
}

export function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
