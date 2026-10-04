import type { ApiClient } from "./http.ts";
import { pollUntil } from "./poll.ts";

export interface LogEntry {
  ts: number;
  level: string;
  module?: string;
  action?: string;
  msg?: string;
  fields: Record<string, unknown>;
}

interface LogTailResponse {
  entries: LogEntry[];
  next_since_ms: number;
  capacity: number;
  size: number;
}

export interface LogQuery {
  module?: string;
  action?: string;
  level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  since?: number;
  limit?: number;
  persona?: "admin" | "member" | "enduser";
}

function toQueryString(q: LogQuery): string {
  const params = new URLSearchParams();
  if (q.module) params.set("module", q.module);
  if (q.action) params.set("action", q.action);
  if (q.level) params.set("level", q.level);
  if (q.since !== undefined) params.set("since", String(q.since));
  params.set("limit", String(q.limit ?? 500));
  return params.toString();
}

export async function getLogEntries(api: ApiClient, q: LogQuery = {}): Promise<LogEntry[]> {
  const res = await api.get<LogTailResponse>(`/v1/diagnostics/logs?${toQueryString(q)}`, {
    persona: q.persona ?? "admin",
  });
  if (res.status !== 200) {
    throw new Error(`diagnostics/logs tail failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.entries ?? [];
}

export type FieldMatch = Record<string, unknown> | ((entry: LogEntry) => boolean);

function matches(entry: LogEntry, where?: FieldMatch): boolean {
  if (!where) return true;
  if (typeof where === "function") return where(entry);
  return Object.entries(where).every(([k, v]) => entry.fields[k] === v);
}

export interface AssertLogOptions extends LogQuery {
  where?: FieldMatch;
  wait?: boolean;
  timeoutMs?: number;
}

export async function assertLogEvent(api: ApiClient, opts: AssertLogOptions): Promise<LogEntry> {
  const find = async (): Promise<LogEntry | null> => {
    const entries = await getLogEntries(api, opts);
    return entries.find((e) => matches(e, opts.where)) ?? null;
  };
  const label = `log event module=${opts.module ?? "*"} action=${opts.action ?? "*"}`;
  if (opts.wait) {
    return pollUntil(find, { timeoutMs: opts.timeoutMs ?? 15_000, label });
  }
  const found = await find();
  if (!found) throw new Error(`expected ${label} in engine logs but none matched`);
  return found;
}

export async function assertRedacted(
  api: ApiClient,
  secret: string,
  q: LogQuery = {},
): Promise<void> {
  const entries = await getLogEntries(api, q);
  const leaked = entries.find((e) => JSON.stringify(e).includes(secret));
  if (leaked) {
    throw new Error(`secret leaked into engine logs: ${JSON.stringify(leaked).slice(0, 300)}`);
  }
}
