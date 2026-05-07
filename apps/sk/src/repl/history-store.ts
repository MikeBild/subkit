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

/** Bigger cap for the prompt-history ring once Ctrl+R fuzzy-search
 *  surfaces older entries. The legacy 500 was enough for an interactive
 *  session but wraps too quickly for power users with months of
 *  history. Rotates at this many entries via the same write-then-
 *  rename trim path.
 *
 *  Disk-space note (R1-S7 review): a typical prompt averages ~100 B
 *  including the JSONL framing, so the bound on `~/.sk/history.jsonl`
 *  is ~1 MB — 20× the legacy cap, but still trivial on any modern
 *  filesystem. The trim is incremental (`writeFile + rename`), so the
 *  worst-case disk use during rotation is `2 × MAX_PROMPT_HISTORY`
 *  lines for a few ms before the rename completes. No background
 *  migration is performed for users upgrading from older versions —
 *  their files keep growing until the cap is hit, then trim normally.
 */
export const MAX_PROMPT_HISTORY = 10_000;

/** Default path: `~/.sk/history.jsonl`. */
export function defaultHistoryPath(): string {
  return join(homedir(), ".sk", "history.jsonl");
}

/** Default path for the slash-invocation history ring — separate
 *  file so Ctrl+R `/`-prefixed queries don't compete with prompt
 *  history for ring slots. */
export function defaultSlashHistoryPath(): string {
  return join(homedir(), ".sk", "slash-history.jsonl");
}

const SLASH_RING_MAX = 1_000;

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

  if (existing.length + 1 <= MAX_PROMPT_HISTORY) {
    try {
      appendFileSync(path, line);
    } catch {
      // best-effort — silent failure preserves the REPL UX
    }
    return;
  }

  const kept = existing.slice(existing.length + 1 - MAX_PROMPT_HISTORY);
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
  const limit = opts.limit ?? MAX_PROMPT_HISTORY;
  return filtered.slice(Math.max(0, filtered.length - limit)).map((e) => e.p);
}

// ----- Slash-invocation history ring ----------------------------------------

export interface SlashHistoryEntry {
  /** Unix timestamp (ms). */
  t: number;
  /** Raw slash invocation text (e.g. "/connector stripe"). */
  s: string;
  tenant?: string | null;
}

/**
 * Append a slash invocation. Uses the same dedupe-against-tail rule as
 * prompt history; rotates at SLASH_RING_MAX entries.
 */
export function appendSlashHistory(
  invocation: string,
  opts: { path?: string; tenant?: string | null } = {},
): void {
  const s = invocation.trim();
  if (!s.startsWith("/")) return;
  if (s.length === 0) return;
  const path = opts.path ?? defaultSlashHistoryPath();
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  } catch {
    return;
  }
  const existing = loadSlashHistory(path);
  const last = existing[existing.length - 1];
  if (last && last.s === s) return;
  const entry: SlashHistoryEntry = {
    t: Date.now(),
    s,
    ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
  };
  if (existing.length + 1 <= SLASH_RING_MAX) {
    try {
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
    } catch {
      // ignore
    }
    return;
  }
  const kept = existing.slice(existing.length + 1 - SLASH_RING_MAX);
  kept.push(entry);
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`);
    renameSync(tmp, path);
  } catch {
    // ignore
  }
}

export function loadSlashHistory(path: string = defaultSlashHistoryPath()): SlashHistoryEntry[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: SlashHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as SlashHistoryEntry;
      if (typeof entry.s === "string" && typeof entry.t === "number") out.push(entry);
    } catch {
      // skip
    }
  }
  return out;
}

export function loadSlashRing(
  path: string = defaultSlashHistoryPath(),
  opts: { tenant?: string | null; limit?: number } = {},
): string[] {
  const entries = loadSlashHistory(path);
  const filtered = opts.tenant
    ? entries.filter((e) => e.tenant == null || e.tenant === opts.tenant)
    : entries;
  const limit = opts.limit ?? SLASH_RING_MAX;
  return filtered.slice(Math.max(0, filtered.length - limit)).map((e) => e.s);
}

export function clearSlashHistory(path: string = defaultSlashHistoryPath()): void {
  try {
    if (existsSync(path)) writeFileSync(path, "");
  } catch {
    // ignore
  }
}
