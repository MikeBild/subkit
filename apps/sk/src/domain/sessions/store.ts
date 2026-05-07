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

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectSecretShape } from "../../lib/secret-shape.ts";

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
  /** Owning tenant slug or id. Set by `appendEvent` when the caller
   *  passes `opts.tenant`. Persisted alongside each event so a single
   *  pasted line still carries its tenant context. R2-W6. */
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
   *  if conversation IDs collide. Strongly recommended for any path
   *  reachable through a switching profile. R2-W6. */
  tenant?: string | null;
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
  opts: AppendOptions = {},
): void {
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
  const tenant = opts.tenant ?? null;
  const event: TurnEvent = {
    ...ev,
    data: scrubbedData,
    ts: now().toISOString(),
    ...(tenant ? { tenant } : {}),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
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
