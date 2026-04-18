// Persistent REPL prompt history. Stored as newline-delimited JSON
// under `~/.sk/history.jsonl` so it survives sk restarts (the
// original sk only kept an in-memory ring per session). The file is
// read-on-load + appended-on-submit with a best-effort file lock so
// two sk processes on the same machine don't interleave writes.
//
// Shape of each line:
//   {"t": 1713456789, "p": "the prompt text", "tenant": "acme"}
//
// Trim policy: on each successful append we read the file back, keep
// the most-recent MAX_HISTORY entries, and rewrite. Cheap for a 100-
// item cap and avoids an unbounded file for long-running users.
//
// Every function takes an explicit `path` so tests can point at a
// tmpdir without touching $HOME.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HistoryEntry {
  /** Unix timestamp (ms). */
  t: number;
  /** Prompt text. */
  p: string;
  /** Tenant slug active when the prompt was submitted — scope filter. */
  tenant?: string | null;
}

export const MAX_HISTORY = 500;

/** Default path: `~/.sk/history.jsonl`. */
export function defaultHistoryPath(): string {
  return join(homedir(), ".sk", "history.jsonl");
}

/**
 * Load the full history file. Missing file → empty list. Malformed
 * lines are skipped silently (the file may have been hand-edited).
 * Entries come back oldest-first (same order as the file).
 */
export function loadHistory(path: string = defaultHistoryPath()): HistoryEntry[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (typeof entry.p === "string" && typeof entry.t === "number") {
        out.push(entry);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Append a prompt. Creates the parent dir if needed, trims to
 * MAX_HISTORY via a rewrite-with-tmp pattern. Deduplicates against
 * the most recent entry (holding down Enter on the same prompt would
 * otherwise flood the file).
 */
export function appendHistory(
  prompt: string,
  opts: { path?: string; tenant?: string | null } = {},
): void {
  const p = prompt.trim();
  if (p.length === 0) return;
  const path = opts.path ?? defaultHistoryPath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }

  const existing = loadHistory(path);
  const last = existing[existing.length - 1];
  if (last && last.p === p) return;

  const entry: HistoryEntry = {
    t: Date.now(),
    p,
    ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
  };
  const line = `${JSON.stringify(entry)}\n`;

  if (existing.length + 1 <= MAX_HISTORY) {
    try {
      appendFileSync(path, line);
    } catch {
      // best-effort — silent failure preserves the REPL UX
    }
    return;
  }

  const kept = existing.slice(existing.length + 1 - MAX_HISTORY);
  kept.push(entry);
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`);
    renameSync(tmp, path);
  } catch {
    // ignore
  }
}

/** Wipe the history file. Used by a future `/history clear` command. */
export function clearHistory(path: string = defaultHistoryPath()): void {
  try {
    if (existsSync(path)) writeFileSync(path, "");
  } catch {
    // ignore
  }
}

/**
 * Return the prompt strings oldest-first, optionally filtered by
 * tenant slug. The REPL stores them in its in-memory ring on start.
 */
export function loadPromptRing(
  path: string = defaultHistoryPath(),
  opts: { tenant?: string | null; limit?: number } = {},
): string[] {
  const entries = loadHistory(path);
  const filtered = opts.tenant
    ? entries.filter((e) => e.tenant == null || e.tenant === opts.tenant)
    : entries;
  const limit = opts.limit ?? MAX_HISTORY;
  return filtered.slice(Math.max(0, filtered.length - limit)).map((e) => e.p);
}
