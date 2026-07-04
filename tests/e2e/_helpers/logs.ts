// Runtime-log assertion helpers.
//
// These let a test assert on the engine's STRUCTURED runtime logs — the
// secondary observability seam the plan calls for, used where there is no
// synchronous API response to assert on (scheduler fan-out, background
// ingest) or to confirm a request was logged + redacted. Backed by
// `GET /v1/diagnostics/logs`, which is tenant-scoped and itself writes a
// `DIAGNOSTICS_LOGS_TAILED` audit row (see
// apps/engine/src/http/routes/diagnostics/logs.ts).
//
// Anti-flake discipline: assert PRESENCE of an event, never an exact count
// or exact message string. Use `module`/`action` filters + field matchers
// so unrelated log volume never flakes the assertion.

import type { ApiClient } from "./http.ts";
import { pollUntil } from "./poll.ts";

/** One entry from the engine's in-memory log ring. */
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
  /** Persona whose tenant scopes the tail. Default "admin". */
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

/** Fetch a tenant-scoped window of log entries via the diagnostics tail. */
export async function getLogEntries(api: ApiClient, q: LogQuery = {}): Promise<LogEntry[]> {
  const res = await api.get<LogTailResponse>(`/v1/diagnostics/logs?${toQueryString(q)}`, {
    persona: q.persona ?? "admin",
  });
  if (res.status !== 200) {
    throw new Error(`diagnostics/logs tail failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.entries ?? [];
}

/** Predicate over a log entry's structured fields. */
export type FieldMatch = Record<string, unknown> | ((entry: LogEntry) => boolean);

function matches(entry: LogEntry, where?: FieldMatch): boolean {
  if (!where) return true;
  if (typeof where === "function") return where(entry);
  return Object.entries(where).every(([k, v]) => entry.fields[k] === v);
}

export interface AssertLogOptions extends LogQuery {
  /** Field equality map OR a custom predicate the entry must satisfy. */
  where?: FieldMatch;
  /** Poll until the event appears (background work). Default false (one-shot). */
  wait?: boolean;
  timeoutMs?: number;
}

/**
 * Assert at least one log entry matches the {module, action, level, where}
 * filter and return it. With `wait: true` the assertion polls (for async /
 * scheduler-fired events that land after the triggering call returns).
 */
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

/**
 * Assert a known secret value never appears verbatim in any log entry's
 * serialized fields — proves the redaction layer scrubbed it. Pass the
 * plaintext token you injected and the query window to scan.
 */
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
