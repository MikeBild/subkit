import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redact } from "@cli-core/index.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const ROTATION_BYTES = 2 * 1024 * 1024;
const ROTATION_KEEP = 2;
const MAX_STRING_FIELD_CHARS = 2000;
const MAX_DEBUG_DEPTH = 10;

export type DebugMode = "ink" | "repl" | "headless" | "command" | "unknown";

export type DebugRecordKind =
  | "dialog.turn_start"
  | "dialog.prompt_resolved"
  | "dialog.warning"
  | "dialog.turn_event"
  | "dialog.render_output"
  | "dialog.turn_end"
  | "dialog.error"
  | "dialog.elicitation_routing"
  | "dialog.plain_prompt_sent"
  | "dialog.elicit_request_received"
  | "conversation.turn_events"
  | "elicitation.response"
  | "http.request"
  | "http.response"
  | "http.transport_error"
  | "http.transport_recovery"
  | "suggest_next.feedback_failed"
  | "oauth.sse_subscribe_failed"
  | "sse.open"
  | "sse.frame"
  | "sse.close"
  | "sse.transport_error"
  | "approval.diff_fetch_failed"
  | "bootstrap.fetch_failed"
  | "bootstrap.cache_write_failed"
  | "bootstrap.cache_read_rejected"
  | "settings.schema_fallback"
  | "session.append_failed"
  | "agent.briefing_hook_failed"
  | "agent.capture_hook_failed";

export interface DebugCorrelationFields {
  mode?: DebugMode;
  session_id?: string | null;
  conversation_id?: string | null;
  turn_id?: string | null;
  trace_id?: string | null;
  request_id?: string | null;
}

export interface DebugRecord extends DebugCorrelationFields {
  ts: string;
  seq: number;
  kind: DebugRecordKind;
  [key: string]: unknown;
}

function envVerbose(): boolean {
  const subkit = process.env.SUBKIT_DEBUG?.toLowerCase().trim();
  if (subkit && TRUTHY.has(subkit)) return true;
  const generic = process.env.DEBUG?.toLowerCase().trim();
  if (generic && (generic === "subkit" || generic === "subkit:*" || generic === "*")) return true;
  return false;
}

function argvVerbose(): boolean {
  for (const arg of process.argv) {
    if (arg === "--debug" || arg === "-d" || arg === "--verbose") return true;
    if (arg.startsWith("--debug=")) return true;
  }
  return false;
}

let cachedVerbose: boolean | null = null;
let writeFailed = false;
let nextRecordSeq = 0;
let nextTurnSeq = 0;

export function isDebugVerbose(): boolean {
  if (envVerbose() || argvVerbose()) return true;
  if (cachedVerbose !== null) return cachedVerbose;
  cachedVerbose = false;
  return cachedVerbose;
}

export function setDebugVerbose(next: boolean): boolean {
  cachedVerbose = next;
  return next;
}

export function debugLogPath(): string {
  const override = process.env.SUBKIT_DEBUG_FILE;
  if (override && override.length > 0) return override;
  return join(homedir(), ".subkit", "debug.log");
}

export function newDebugTurnId(prefix = "turn"): string {
  nextTurnSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextTurnSeq.toString(36)}`;
}

export function extractTraceId(headers: Headers): string | null {
  return headers.get("x-trace-id") ?? headers.get("x-request-id") ?? null;
}

export function serializeDebugError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const errFields = err as Error & Record<string, unknown>;
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (typeof err.stack === "string" && err.stack.length > 0) out.stack = err.stack;
    if ("cause" in err && err.cause !== undefined) {
      out.cause =
        err.cause instanceof Error
          ? { name: err.cause.name, message: err.cause.message }
          : err.cause;
    }
    for (const key of ["status", "code", "trace_id", "details", "body"] as const) {
      if (key in errFields) {
        const value = errFields[key];
        if (value !== undefined) out[key] = value;
      }
    }
    return out;
  }
  if (typeof err === "object" && err !== null) {
    return {
      message:
        "message" in err && typeof err.message === "string" ? err.message : JSON.stringify(err),
      error: err,
    };
  }
  return { message: String(err) };
}

function rotateIfNeeded(path: string): void {
  let size: number;
  try {
    size = fs.statSync(path).size;
  } catch {
    return;
  }
  if (size < ROTATION_BYTES) return;
  for (let i = ROTATION_KEEP; i >= 1; i--) {
    const src = i === 1 ? path : `${path}.${i - 1}`;
    const dst = `${path}.${i}`;
    try {
      if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
    } catch {}
    try {
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    } catch {}
  }
}

function appendRecord(rec: DebugRecord): void {
  const path = debugLogPath();
  const line = `${JSON.stringify(rec)}\n`;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    fs.appendFileSync(path, line, { encoding: "utf8" });
  } catch (err) {
    if (!writeFailed) {
      writeFailed = true;
      process.stderr.write(
        `subkit: debug log unavailable (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }
}

function summarizeLongString(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `[truncated ${value.length} chars sha256=${hash}]`;
}

function compactDebugValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_FIELD_CHARS ? summarizeLongString(value) : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEBUG_DEPTH) return "[truncated nested object]";
  if (Array.isArray(value)) return value.map((item) => compactDebugValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = compactDebugValue(item, depth + 1);
  }
  return out;
}

interface TraceSink {
  write(text: string): unknown;
}

let traceSink: TraceSink | null = null;

export function enableRequestTrace(sink: TraceSink | null): void {
  traceSink = sink;
}

export function requestTraceLine(
  kind: DebugRecordKind,
  record: Record<string, unknown>,
): string | null {
  if (kind !== "http.response" && kind !== "http.transport_error") return null;
  const method = typeof record.method === "string" ? record.method : "?";
  const path = typeof record.path === "string" ? record.path : "?";
  const duration = typeof record.duration_ms === "number" ? `${record.duration_ms}ms` : "?ms";
  const trace = typeof record.trace_id === "string" ? ` trace=${record.trace_id}` : "";
  if (kind === "http.transport_error")
    return `subkit: ${method} ${path} failed after ${duration}${trace}`;
  return `subkit: ${method} ${path} ${String(record.status ?? "?")} ${duration}${trace}`;
}

export function debugLog(
  kind: DebugRecordKind,
  fields: Record<string, unknown> = {},
  context: DebugCorrelationFields = {},
): void {
  const raw: DebugRecord = {
    ts: new Date().toISOString(),
    seq: ++nextRecordSeq,
    kind,
    ...context,
    ...fields,
  };
  appendRecord(compactDebugValue(redact(raw)) as DebugRecord);
  const line = traceSink
    ? requestTraceLine(
        kind,
        redact({ ...fields, trace_id: fields.trace_id ?? context.trace_id }) as Record<
          string,
          unknown
        >,
      )
    : null;
  if (line) traceSink?.write(`${line}\n`);
}

export function debugLogTail(maxLines = 40): string[] {
  const path = debugLogPath();
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  return lines.slice(-maxLines);
}
