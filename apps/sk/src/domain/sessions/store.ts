// JSONL event store for sk conversations.
//
// `apps/sk/src/sessions.ts` already persists per-conversation metadata
// (id, tenant, model, last activity). This module adds a *body* —
// each conversation's turns are appended to a JSONL log at
// `~/.sk/sessions/{conversationId}.jsonl`, one event per line.
//
// Why JSONL: append-only, line-by-line readable, durable on partial
// writes (the tail can be a partial line and we just skip it on read),
// and easy to diff / grep without a parser. Mirrors the Claude Code
// session-persistence shape so power users have one mental model.
//
// The store is intentionally narrow — it only knows about *events*
// (turn boundaries, text deltas, tool calls, errors). The conversation
// metadata (model, status, owner) stays in `sessions.ts`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { trimJsonlFile } from "@shared/jsonl-ring.ts";
import { debugLog, serializeDebugError } from "../../debug.ts";
import { detectSecretShape } from "../../lib/secret-shape.ts";

/** Maximum events retained per session JSONL log. After this many
 *  events the file is trimmed to the most recent half via
 *  write-then-rename — the same shape `MAX_PROMPT_HISTORY` uses for
 *  the prompt ring. R5-W5 review fix: prevents an unbounded session
 *  from filling the disk in long-running CI runs.
 *
 *  Sized for "a marathon debugging session" — average event size
 *  ~250 B, so the cap is ~1.25 MB on disk before trimming kicks in.
 *  Trimming keeps the most recent half so the operator's "what just
 *  happened?" history is preserved even after the cut. */
export const MAX_EVENTS_PER_SESSION = 5_000;

export type TurnEventKind =
  | "user_message"
  | "assistant_delta"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "error"
  | "completed"
  | "cancelled";

export interface TurnEvent {
  /** Stable monotonically-increasing event ordinal within the session. */
  seq: number;
  /** ISO-8601 wall-clock timestamp. */
  ts: string;
  /** Event family. */
  kind: TurnEventKind;
  /** Owning tenant slug or id. Required on every write (R4-W5).
   *  Persisted alongside each event so a single pasted line still
   *  carries its tenant context. Optional in the type to allow
   *  loading legacy flat-layout files written before R4-W5; new
   *  writes always populate it. */
  tenant?: string;
  /** Free-form payload — every kind defines its own shape. */
  data: Record<string, unknown>;
}

/**
 * Walk the event payload and replace any string values that match the
 * secret-shape classifier (PATs, OAuth tokens, Bearer tokens, etc.)
 * with `"***redacted***"`. Recursive over nested objects + arrays.
 *
 * The append path is per-user disk (mode 0o600 in the user's home
 * dir), so this is not a tenant-isolation issue, but redacting
 * obviously-sensitive values keeps the logs safe to share for
 * support / replay scenarios.
 */
export function scrubSecrets(data: unknown): unknown {
  if (typeof data === "string") {
    const shape = detectSecretShape(data);
    return shape.matched ? "***redacted***" : data;
  }
  if (Array.isArray(data)) return data.map(scrubSecrets);
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = scrubSecrets(v);
    }
    return out;
  }
  return data;
}

export interface AppendOptions {
  /** Override the sessions dir (defaults to `~/.sk/sessions`). */
  dir?: string;
  /** Tenant slug or id — namespaces the on-disk path so a forensic
   *  reader can immediately tell which tenant owns the JSONL even
   *  if conversation IDs collide. R4-W5: now REQUIRED on every
   *  write so that a caller forgetting to pass it fails the
   *  typecheck rather than silently landing on the legacy flat
   *  `~/.sk/sessions/{conv}.jsonl` path. `loadEvents` keeps it
   *  optional so older flat-layout files stay readable. */
  tenant: string;
  /** Inject a clock for tests. */
  now?: () => Date;
}

export function sessionsDir(override?: string): string {
  return override ?? join(homedir(), ".sk", "sessions");
}

/** Path for a conversation's JSONL log. When `tenant` is provided
 *  the file lives under `~/.sk/sessions/{tenant}/{conv}.jsonl`;
 *  otherwise it falls back to the legacy flat layout
 *  `~/.sk/sessions/{conv}.jsonl` so already-written logs from older
 *  versions of the CLI keep loading. New writes always specify a
 *  tenant and get the namespaced path. */
export function sessionEventsPath(
  conversationId: string,
  dir?: string,
  tenant?: string | null,
): string {
  const root = sessionsDir(dir);
  if (tenant) {
    // Sanitise: tenants are slugs/uuids in practice, but a malicious
    // override that contains `..` or `/` could escape. Replace any
    // non-alphanumeric/`-`/`_` char with `_`.
    const safe = tenant.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(root, safe, `${conversationId}.jsonl`);
  }
  return join(root, `${conversationId}.jsonl`);
}

/**
 * Append one event to the conversation's JSONL log. Best-effort:
 * if the file system rejects the write (read-only volume, full
 * disk) we silently drop the event rather than crash the REPL.
 */
export function appendEvent(
  conversationId: string,
  ev: Omit<TurnEvent, "ts">,
  opts: AppendOptions,
): void {
  // R8-S4: runtime guard for the typecheck-required `tenant` field.
  // The empty string would survive the type check but land sessions
  // under `~/.sk/sessions/_/{conv}.jsonl` (the path sanitiser maps
  // empty input to `_`). Reject loud at the boundary.
  if (!opts.tenant || opts.tenant.length === 0) {
    throw new Error("appendEvent: opts.tenant is required and must be non-empty");
  }
  const path = sessionEventsPath(conversationId, opts.dir, opts.tenant);
  const now = opts.now ?? (() => new Date());
  // Scrub obviously-secret-shaped strings out of `data` before the
  // line lands on disk. The classifier only catches well-known token
  // shapes (PATs, Bearer tokens, OAuth) — callers passing free-form
  // credentials still own redaction at their layer.
  const scrubbedData = scrubSecrets(ev.data) as Record<string, unknown>;
  // Embed the tenant in the event payload too — even if a forensic
  // reader receives a single line in isolation (e.g. paste from a
  // bug report) the tenant context is preserved alongside the
  // conversation id.
  const event: TurnEvent = {
    ...ev,
    data: scrubbedData,
    ts: now().toISOString(),
    tenant: opts.tenant,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    // R5-W5 + R6-S1: trigger the trim when the file is plausibly
    // over the documented cap. Average event size ~250 B → 5,000
    // events ≈ 1.25 MB. Multiplier `* 256` gives a 1.28 MB
    // threshold so the trim fires close to the stated cap rather
    // than 5x earlier (the previous `* 64` threshold gave an
    // effective cap of ~2,500 events because the file had only
    // grown to 320 KB before trimming).
    if (statSync(path).size > MAX_EVENTS_PER_SESSION * 256) {
      maybeTrimJsonl(path, MAX_EVENTS_PER_SESSION);
    }
  } catch (err) {
    // R7-S3: best-effort write, but surface the failure via debugLog
    // so a read-only `~/.sk` (CI runner, container with mounted
    // tmpfs) doesn't silently drop every event. Pairs with
    // `bootstrap.cache_write_failed`.
    debugLog("session.append_failed", { path, error: serializeDebugError(err) }, {});
  }
}

/** Trim the conversation's JSONL log to the most recent
 *  `keep / 2` events. Delegates the atomic write-then-rename to the
 *  shared helper at `@shared/jsonl-ring`. The trim halves rather
 *  than truncates-to-keep so the next size check has headroom
 *  before firing again. R6-S6 (helper extraction). */
function maybeTrimJsonl(path: string, keep: number): void {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  trimJsonlFile(path, content, Math.floor(keep / 2));
}

/**
 * Read every event from the conversation's JSONL log. Skips truncated
 * trailing lines. Returns events in the order they were written.
 */
export function loadEvents(
  conversationId: string,
  dir?: string,
  tenant?: string | null,
): TurnEvent[] {
  const path = sessionEventsPath(conversationId, dir, tenant);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n");
  const events: TurnEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as TurnEvent;
      if (typeof ev.seq === "number" && typeof ev.kind === "string") {
        events.push(ev);
      }
    } catch {
      // Trailing partial line on crash — ignore.
    }
  }
  return events;
}

/** Delete the JSONL log for a conversation. Best-effort. */
export function deleteEvents(conversationId: string, dir?: string, tenant?: string | null): void {
  const path = sessionEventsPath(conversationId, dir, tenant);
  try {
    unlinkSync(path);
  } catch {
    /* gone already */
  }
}
