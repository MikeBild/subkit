// SUBKIT.md discovery + merge.
//
// The `sk` CLI walks upward from cwd looking for a `SUBKIT.md` file and
// also reads `~/.sk/SUBKIT.md`. When both exist, contents are merged
// with the user-level memory first and the project memory second, so
// project context takes precedence for nearby questions.
//
// The merged string is passed to the engine as the `memory` field on
// every turn. The engine persists it on `conversations.memory` and
// slots it into the LLM context pipeline's "User memory" section.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_MEMORY_BYTES = 262144;

export interface LoadMemoryOptions {
  cwd?: string;
  /** Set to false (via `--no-memory` or settings) to skip entirely. */
  include?: boolean;
  /** Soft cap on the combined memory; excess is truncated with a marker. */
  max_bytes?: number;
}

export interface LoadMemoryResult {
  /** The merged memory payload, or null when nothing was found / include=false. */
  content: string | null;
  /** Paths actually read, in the order they were merged. */
  sources: string[];
  /** Whether the payload was truncated to fit within max_bytes. */
  truncated: boolean;
}

/**
 * Walk upward from cwd until we hit filesystem root OR the home dir,
 * collecting any `SUBKIT.md` files we find along the way. Closest to
 * cwd wins — we return in the reverse order (root-most first) so the
 * merged string has the closest context last.
 */
function walkUpward(cwd: string): string[] {
  const home = homedir();
  const results: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, "SUBKIT.md");
    if (existsSync(candidate)) results.push(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    // Stop walking once we've climbed above the home dir. Keeps /tmp
    // tests and non-repo dirs from picking up a stray global file.
    if (dir === home) break;
    dir = parent;
  }
  return results.reverse();
}

export function loadMemory(opts: LoadMemoryOptions = {}): LoadMemoryResult {
  if (opts.include === false) {
    return { content: null, sources: [], truncated: false };
  }
  const cwd = opts.cwd ?? process.cwd();
  const maxBytes = opts.max_bytes ?? MAX_MEMORY_BYTES;
  const sources: string[] = [];

  // Start with ~/.sk/SUBKIT.md so project memory can override it.
  const userPath = join(homedir(), ".sk", "SUBKIT.md");
  if (existsSync(userPath)) sources.push(userPath);
  for (const p of walkUpward(cwd)) sources.push(p);

  if (sources.length === 0) {
    return { content: null, sources: [], truncated: false };
  }

  const parts: string[] = [];
  for (const path of sources) {
    try {
      const body = readFileSync(path, "utf8");
      parts.push(`# Memory from ${path}\n${body.trim()}`);
    } catch {
      /* unreadable — skip silently */
    }
  }
  let merged = parts.join("\n\n");
  let truncated = false;
  if (merged.length > maxBytes) {
    merged = `${merged.slice(0, maxBytes)}\n\n[sk: memory truncated at ${maxBytes} bytes]`;
    truncated = true;
  }
  return { content: merged, sources, truncated };
}
