import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_MEMORY_BYTES = 262144;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

function clipToBytes(s: string, max: number): string {
  if (byteLen(s) <= max) return s;
  let out = Buffer.from(s, "utf8").subarray(0, Math.max(0, max)).toString("utf8");
  while (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

interface LoadMemoryOptions {
  cwd?: string;
  include?: boolean;
  max_bytes?: number;
}

interface LoadMemoryResult {
  content: string | null;
  sources: string[];
  truncated: boolean;
}

function walkUpward(cwd: string): string[] {
  const home = homedir();
  const results: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, "SK.md");
    if (existsSync(candidate)) results.push(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
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

  const userPath = join(homedir(), ".subkit", "SK.md");
  if (existsSync(userPath)) sources.push(userPath);
  for (const p of walkUpward(cwd)) sources.push(p);

  if (sources.length === 0) {
    return { content: null, sources: [], truncated: false };
  }

  const sections: Array<{ path: string; text: string }> = [];
  for (const path of sources) {
    try {
      const body = readFileSync(path, "utf8");
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
      sections.push({ path, text: `# Memory from ${path} (sha256:${hash})\n${body.trim()}` });
    } catch {}
  }
  if (sections.length === 0) {
    return { content: null, sources, truncated: false };
  }

  const sep = "\n\n";
  const sizeOf = (): number =>
    sections.reduce((n, s, i) => n + byteLen(s.text) + (i > 0 ? byteLen(sep) : 0), 0);
  let truncated = false;
  for (let i = 0; i < sections.length - 1 && sizeOf() > maxBytes; i++) {
    const sec = sections[i]!;
    sec.text = `${sec.text.split("\n", 1)[0]}\n[subkit: section dropped — memory over ${maxBytes} bytes]`;
    truncated = true;
  }
  if (sizeOf() > maxBytes) {
    const last = sections[sections.length - 1]!;
    const room = Math.max(0, maxBytes - (sizeOf() - byteLen(last.text)));
    last.text = `${clipToBytes(last.text, room)}\n[subkit: memory truncated at ${maxBytes} bytes]`;
    truncated = true;
  }
  return { content: sections.map((s) => s.text).join(sep), sources, truncated };
}
