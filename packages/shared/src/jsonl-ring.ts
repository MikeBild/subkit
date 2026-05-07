// Shared JSONL ring-buffer trim helper.
//
// Three call sites in the CLI used to re-implement the same
// "append unless > N, then rewrite via tmp + rename" shape:
//
//   - apps/sk/src/repl/history-store.ts (prompt history ring)
//   - apps/sk/src/repl/history-store.ts (slash-invocation ring)
//   - apps/sk/src/domain/sessions/store.ts (per-conversation event log)
//
// Each implementation drifted slightly (only the session store
// applied `mode: 0o600`, only the history store dedup'd against the
// tail). The reviewer flagged this as suggestion R5-S6 and again as
// R6-S6 ("extract now while the diff is small"). The shared helper
// owns: the atomic write-then-rename, the explicit file mode, and
// the "keep tail of N" trim. Callers still own their dedup and
// schema concerns.
//
// The helper reads the entire file once during trim. Callers should
// debounce the trim (e.g. only call when `statSync(path).size`
// suggests a likely overrun); this helper does NOT decide *when* to
// trim, only *how*.

import { renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface JsonlTrimOptions {
  /** Mode for the rewritten file. Default 0o600 — caller-readable
   *  only. Override only if the file is intentionally world-readable. */
  mode?: number;
}

/**
 * Trim a JSONL file in-place to its most recent `keep` non-empty
 * lines via write-then-rename. Atomic on POSIX: readers either see
 * the old file or the new one, never a half-written truncation. The
 * caller passes the *current* file content; this helper does the
 * line-counting and rewrite. Returns:
 *
 *   - `{ trimmed: false }` if the file already has ≤ `keep` lines
 *     (no rewrite happens; caller can no-op).
 *   - `{ trimmed: true, kept }` after a successful rewrite, with
 *     `kept` = the number of lines retained.
 *
 * On rewrite failure, the helper attempts to remove the temp file
 * and returns `{ trimmed: false }`. The original file is untouched
 * because `renameSync` either lands the temp file or it doesn't.
 */
export function trimJsonlFile(
  path: string,
  content: string,
  keep: number,
  opts: JsonlTrimOptions = {},
): { trimmed: boolean; kept?: number } {
  const lines = content.split("\n").filter((l) => l.length > 0);
  if (lines.length <= keep) return { trimmed: false };
  // Keep `keep` lines. Caller picks the meaning — typically "most
  // recent N" since JSONL grows append-only.
  const head = Math.max(0, lines.length - keep);
  const trimmed = lines.slice(head).join("\n");
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const mode = opts.mode ?? 0o600;
  try {
    writeFileSync(tmp, `${trimmed}\n`, { encoding: "utf8", mode });
    renameSync(tmp, path);
    return { trimmed: true, kept: lines.length - head };
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing left to clean up */
    }
    return { trimmed: false };
  }
}
