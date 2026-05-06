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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  /** Free-form payload — every kind defines its own shape. */
  data: Record<string, unknown>;
}

export interface AppendOptions {
  /** Override the sessions dir (defaults to `~/.sk/sessions`). */
  dir?: string;
  /** Inject a clock for tests. */
  now?: () => Date;
}

export function sessionsDir(override?: string): string {
  return override ?? join(homedir(), ".sk", "sessions");
}

export function sessionEventsPath(conversationId: string, dir?: string): string {
  return join(sessionsDir(dir), `${conversationId}.jsonl`);
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
  const path = sessionEventsPath(conversationId, opts.dir);
  const now = opts.now ?? (() => new Date());
  const event: TurnEvent = { ...ev, ts: now().toISOString() };
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
export function loadEvents(conversationId: string, dir?: string): TurnEvent[] {
  const path = sessionEventsPath(conversationId, dir);
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
export function deleteEvents(conversationId: string, dir?: string): void {
  const path = sessionEventsPath(conversationId, dir);
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.unlinkSync(path);
  } catch {
    /* gone already */
  }
}
