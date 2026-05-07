// Full-trace debug logger for the `sk` CLI.
//
// File logging is ALWAYS on. Records are appended as JSON-Lines to
// `~/.sk/debug.log` (or `$SK_DEBUG_FILE`) so an operator can grep a
// failure without asking the user to set an env var first. The log
// rotates at 2 MB; the previous two generations are kept as
// `debug.log.1` and `debug.log.2`.
//
// Verbose mode (env `SK_DEBUG=1` / `DEBUG=sk[:*]` / argv `--debug` /
// `setDebugVerbose(true)`) only controls whether HTTP bodies and raw
// SSE frame payloads are persisted — those are expensive to write and
// remain sensitive even after `redact()`. Default-off keeps the log
// usable; flip it on when you need full traces.
//
// Records are redacted before they hit disk so secrets do not leak
// into local artifacts.

import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redact } from "@cli-core/index.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const ROTATION_BYTES = 2 * 1024 * 1024;
const ROTATION_KEEP = 2; // keep debug.log.1 and debug.log.2

export type DebugMode = "ink" | "repl" | "headless" | "command" | "unknown";

export type DebugRecordKind =
  | "dialog.turn_start"
  | "dialog.prompt_resolved"
  | "dialog.warning"
  | "dialog.turn_event"
  | "dialog.render_output"
  | "dialog.turn_end"
  | "dialog.error"
  // dialog.elicitation_routing — emitted on every keystroke that
  // reaches the pending-elicitation branch with how the input was
  // classified (confirm / reject / pick / structured_only). Lets a
  // "the user typed yes but nothing happened" investigation answer
  // "did the CLI route it as confirm? as ambiguous?" from a single
  // log file.
  | "dialog.elicitation_routing"
  // dialog.plain_prompt_sent — emitted right before forwarding a
  // plain prompt to the engine. Carries `had_recent_unresolved_intent`
  // (true when the assistant's last message looks like
  // "Reply 'yes' to commit" but no elicit_request was emitted —
  // strong signal of an engine policy-gate bug).
  | "dialog.plain_prompt_sent"
  // dialog.elicit_request_received — emitted when an elicit_request
  // SSE frame arrives client-side. Bookends the engine's
  // `elicitation.created` log so a "did the prompt actually reach
  // the CLI?" question is one grep away across both halves.
  | "dialog.elicit_request_received"
  | "conversation.turn_events"
  | "elicitation.response"
  | "http.request"
  | "http.response"
  | "http.transport_error"
  // http.transport_recovery — emitted when engine-client recovers from
  // a transient ECONNRESET / socket-closed mid-turn by retrying or
  // synthesising state from a re-fetched conversation detail. The
  // `strategy` field distinguishes the path so post-mortems can
  // separate "we retried and the engine accepted it" from "we replayed
  // via getConversation".
  | "http.transport_recovery"
  | "sse.open"
  | "sse.frame"
  | "sse.close"
  | "sse.transport_error"
  | "approval.diff_fetch_failed"
  // bootstrap.fetch_failed — emitted when /v1/sk/bootstrap rejects
  // (404 = older engine, 401 = revoked api_key, 500 = engine bug,
  // network = unreachable). The CLI falls through to the legacy
  // tiered persona-probe regardless; this record keeps the failure
  // diagnosable without a packet capture.
  | "bootstrap.fetch_failed"
  // settings.schema_fallback — emitted when an engine-served schema
  // descriptor declares an `enum` field with zero values, which is
  // invalid in zod. The loader coerces to `z.string()` so the form
  // renders, but this is a sign that the engine shipped a malformed
  // descriptor (typically: a connector whose enum source returned
  // an empty list). R2-S10 review fix.
  | "settings.schema_fallback";

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
  const sk = process.env.SK_DEBUG?.toLowerCase().trim();
  if (sk && TRUTHY.has(sk)) return true;
  const generic = process.env.DEBUG?.toLowerCase().trim();
  if (generic && (generic === "sk" || generic === "sk:*" || generic === "*")) return true;
  return false;
}

function argvVerbose(): boolean {
  for (const arg of process.argv) {
    if (arg === "--debug" || arg === "-d") return true;
    if (arg.startsWith("--debug=")) return true;
  }
  return false;
}

let cachedVerbose: boolean | null = null;
let writeFailed = false;
let nextRecordSeq = 0;
let nextTurnSeq = 0;

/**
 * Verbose mode controls whether HTTP/SSE bodies are persisted.
 * File logging itself is always on regardless.
 */
export function isDebugVerbose(): boolean {
  if (cachedVerbose !== null) return cachedVerbose;
  cachedVerbose = envVerbose() || argvVerbose();
  return cachedVerbose;
}

/**
 * Programmatic toggle for verbose mode — used by `/debug on|off` to
 * flip body capture without a restart. Returns the new state.
 */
export function setDebugVerbose(next: boolean): boolean {
  cachedVerbose = next;
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

function rotateIfNeeded(path: string): void {
  let size: number;
  try {
    size = fs.statSync(path).size;
  } catch {
    return; // file does not exist yet — nothing to rotate
  }
  if (size < ROTATION_BYTES) return;
  // Rotate: debug.log.2 -> unlink, debug.log.1 -> debug.log.2, debug.log -> debug.log.1
  for (let i = ROTATION_KEEP; i >= 1; i--) {
    const src = i === 1 ? path : `${path}.${i - 1}`;
    const dst = `${path}.${i}`;
    try {
      if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
    } catch {
      /* best effort */
    }
    try {
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    } catch {
      /* best effort */
    }
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
