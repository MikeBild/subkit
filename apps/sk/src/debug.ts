// Full-trace debug logger for the `sk` CLI.
//
// Activation (any of):
//   - `SK_DEBUG=1` env var (or `DEBUG=sk` / `DEBUG=sk:*`)
//   - `--debug` / `-d` argv flag
//
// When active, `sk` appends JSON-Lines records to `~/.sk/debug.log`.
// The records are structured, correlated per turn, and redacted before
// they hit disk so operators can inspect failures without leaking
// secrets into local debug artifacts.

import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redact } from "@cli-core/index.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type DebugMode = "ink" | "repl" | "headless" | "command" | "unknown";

export type DebugRecordKind =
  | "dialog.turn_start"
  | "dialog.prompt_resolved"
  | "dialog.warning"
  | "dialog.turn_event"
  | "dialog.render_output"
  | "dialog.turn_end"
  | "dialog.error"
  | "conversation.turn_events"
  | "elicitation.response"
  | "http.request"
  | "http.response"
  | "http.transport_error"
  | "sse.open"
  | "sse.frame"
  | "sse.close"
  | "sse.transport_error";

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

function envEnabled(): boolean {
  const sk = process.env.SK_DEBUG?.toLowerCase().trim();
  if (sk && TRUTHY.has(sk)) return true;
  const generic = process.env.DEBUG?.toLowerCase().trim();
  if (generic && (generic === "sk" || generic === "sk:*" || generic === "*")) return true;
  return false;
}

function argvEnabled(): boolean {
  for (const arg of process.argv) {
    if (arg === "--debug" || arg === "-d") return true;
    if (arg.startsWith("--debug=")) return true;
  }
  return false;
}

let cachedActive: boolean | null = null;
let writeFailed = false;
let nextRecordSeq = 0;
let nextTurnSeq = 0;

export function isDebugMode(): boolean {
  if (cachedActive !== null) return cachedActive;
  cachedActive = envEnabled() || argvEnabled();
  return cachedActive;
}

/**
 * Programmatic toggle — used by `/debug on|off` to flip mode without
 * a restart. Returns the new state.
 */
export function setDebugMode(next: boolean): boolean {
  cachedActive = next;
  return next;
}

export function debugLogPath(): string {
  const override = process.env.SK_DEBUG_FILE;
  if (override && override.length > 0) return override;
  return join(homedir(), ".sk", "debug.log");
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

function appendRecord(rec: DebugRecord): void {
  const path = debugLogPath();
  const line = `${JSON.stringify(rec)}\n`;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.appendFileSync(path, line, { encoding: "utf8" });
  } catch (err) {
    // Avoid noisy fallbacks every request when the file system is
    // misconfigured. Surface ONCE on stderr, then go silent so debug
    // never breaks the user's session.
    if (!writeFailed) {
      writeFailed = true;
      process.stderr.write(
        `sk: debug log unavailable (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }
}

export function debugLog(
  kind: DebugRecordKind,
  fields: Record<string, unknown> = {},
  context: DebugCorrelationFields = {},
): void {
  if (!isDebugMode()) return;
  const raw: DebugRecord = {
    ts: new Date().toISOString(),
    seq: ++nextRecordSeq,
    kind,
    ...context,
    ...fields,
  };
  appendRecord(redact(raw) as DebugRecord);
}

/**
 * Read the tail of the debug log for `/debug tail` rendering. Returns
 * an empty array when the file does not yet exist.
 */
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
