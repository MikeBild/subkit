import { AsyncLocalStorage } from "node:async_hooks";

export type LogRequestSource =
  | "api"
  | "cli"
  | "scheduler"
  | "mcp"
  | "webhook"
  | "tool-chain"
  | "ui"
  | "chat"
  | "queue";

export type LogContext = {
  execution_privacy?: "sensitive" | undefined;
  trace_id?: string;

  db_tx_id?: string;
  audit_trace_id?: string | undefined;
  span_id?: string;
  tenant_id?: string;
  execution_id?: string;
  workflow_id?: string;
  request_source?: LogRequestSource;
  audit_origin_source?: LogRequestSource | undefined;
  audit_execution_source?: LogRequestSource | undefined;
  conversation_id?: string;
  actor_id?: string;
  api_key_id?: string;
  session_id?: string;
  audit_access_type?:
    | "api_key"
    | "browser_session"
    | "mcp_oauth"
    | "token_exchange"
    | "external_bearer"
    | "task_run"
    | "portal_token"
    | "device_runner";
  audit_oauth_client_id?: string;
  audit_credential_origin?: "cli_oauth_session";
  auth_via?: "token_exchange" | undefined;
};

const storage = new AsyncLocalStorage<LogContext>();

export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged: LogContext = { ...(storage.getStore() ?? {}), ...ctx };
  return storage.run(merged, fn);
}

export function withIsolatedContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): LogContext {
  return storage.getStore() ?? {};
}

export function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
