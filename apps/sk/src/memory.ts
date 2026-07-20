// SK.md discovery + merge.
//
// The `sk` CLI walks upward from cwd looking for a `SK.md` file and
// also reads `~/.sk/SK.md`. When both exist, contents are merged
// with the user-level memory first and the project memory second, so
// project context takes precedence for nearby questions.
//
// The merged string is passed to the engine as the `memory` field on
// every turn. The engine persists it on `conversations.memory` and
// slots it into the LLM context pipeline's "User memory" section.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_MEMORY_BYTES = 262144;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** Clip to at most `max` UTF-8 bytes without splitting a code point. */
function clipToBytes(s: string, max: number): string {
  if (byteLen(s) <= max) return s;
  let out = Buffer.from(s, "utf8").subarray(0, Math.max(0, max)).toString("utf8");
  // A split multi-byte sequence decodes to a replacement char — drop it.
  while (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

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
 * collecting any `SK.md` files we find along the way. Closest to
 * cwd wins — we return in the reverse order (root-most first) so the
 * merged string has the closest context last.
 */
function walkUpward(cwd: string): string[] {
  const home = homedir();
  const results: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, "SK.md");
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

  // Start with ~/.sk/SK.md so project memory can override it.
  const userPath = join(homedir(), ".sk", "SK.md");
  if (existsSync(userPath)) sources.push(userPath);
  for (const p of walkUpward(cwd)) sources.push(p);

  if (sources.length === 0) {
    return { content: null, sources: [], truncated: false };
  }

  // One section per source, in priority order: user-global first,
  // far ancestors next, the cwd-closest project file LAST (highest
  // priority — it must survive a squeeze). The header carries the
  // source path and a content hash so a session transcript shows
  // exactly which revision of which file was in effect.
  const sections: Array<{ path: string; text: string }> = [];
  for (const path of sources) {
    try {
      const body = readFileSync(path, "utf8");
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
      sections.push({ path, text: `# Memory from ${path} (sha256:${hash})\n${body.trim()}` });
    } catch {
      /* unreadable — skip silently */
    }
  }
  if (sections.length === 0) {
    return { content: null, sources, truncated: false };
  }

  // Byte-accurate budget (the old code measured UTF-16 code units and
  // sliced the MERGED string's head — which discarded exactly the
  // highest-priority, cwd-closest section first). Enforce per source,
  // lowest priority first: drop whole low-priority sections to a
  // one-line marker; only if the remaining closest content still
  // overflows, clip its tail.
  const sep = "\n\n";
  const sizeOf = (): number =>
    sections.reduce((n, s, i) => n + byteLen(s.text) + (i > 0 ? byteLen(sep) : 0), 0);
  let truncated = false;
  for (let i = 0; i < sections.length - 1 && sizeOf() > maxBytes; i++) {
    const sec = sections[i]!;
    sec.text = `${sec.text.split("\n", 1)[0]}\n[sk: section dropped — memory over ${maxBytes} bytes]`;
    truncated = true;
  }
  if (sizeOf() > maxBytes) {
    const last = sections[sections.length - 1]!;
    const room = Math.max(0, maxBytes - (sizeOf() - byteLen(last.text)));
    last.text = `${clipToBytes(last.text, room)}\n[sk: memory truncated at ${maxBytes} bytes]`;
    truncated = true;
  }
  return { content: sections.map((s) => s.text).join(sep), sources, truncated };
}
