import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const BINARY_SUFFIXES = [
  ".gif",
  ".png",
  ".jpg",
  ".jpeg",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".zip",
];

function trackedFiles(cwd: string = root, env = process.env): string[] {
  const listing = Bun.spawnSync(["git", "ls-files", "-z"], { cwd, env });
  if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
  return listing.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0);
}

function nulAt(bytes: Buffer): { offset: number; line: number } | null {
  const offset = bytes.indexOf(0);
  if (offset < 0) return null;
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (bytes[i] === 0x0a) line += 1;
  return { offset, line };
}

describe("no tracked source file is invisible to text search", () => {
  const files = trackedFiles();
  const scanned = files.filter(
    (path) => !BINARY_SUFFIXES.some((suffix) => path.toLowerCase().endsWith(suffix)),
  );

  test("the scan is not vacuous", () => {
    expect(scanned.length).toBeGreaterThan(1_000);
    expect(scanned).toContain("tests/contract/no-nul-bytes.test.ts");
  });

  test("the detector finds a NUL where there is one", () => {
    expect(nulAt(Buffer.from('const key = ["a"].join("\0");', "utf8"))).toEqual({
      offset: 24,
      line: 1,
    });
    expect(nulAt(Buffer.from("first\nsecond\0", "utf8"))).toEqual({ offset: 12, line: 2 });
    expect(nulAt(Buffer.from('const key = ["a"].join("\\0");', "utf8"))).toBeNull();
  });

  test("no NUL byte in any tracked file that is not a binary format", () => {
    const found: string[] = [];
    for (const path of scanned) {
      const hit = nulAt(readFileSync(join(root, path)));
      if (hit !== null) found.push(`${path} — NUL at offset ${hit.offset}, line ${hit.line}`);
    }
    expect(
      found,
      `a NUL byte makes the whole file "data" to file(1) and invisible to every grep that skips binaries:\n  ${found.join("\n  ")}`,
    ).toEqual([]);
  }, 30_000);

  test("and it says nothing about an UNTRACKED file — the known limit, driven", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "nul-untracked-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(sandbox, ".git", "index") };
    try {
      expect(Bun.spawnSync(["git", "init", "-q"], { cwd: sandbox, env }).exitCode).toBe(0);
      writeFileSync(join(sandbox, "tracked.ts"), Buffer.from('join("\0");', "utf8"));
      writeFileSync(join(sandbox, "untracked.ts"), Buffer.from('join("\0");', "utf8"));
      expect(Bun.spawnSync(["git", "add", "tracked.ts"], { cwd: sandbox, env }).exitCode).toBe(0);

      expect(nulAt(readFileSync(join(sandbox, "tracked.ts")))).not.toBeNull();
      expect(nulAt(readFileSync(join(sandbox, "untracked.ts")))).not.toBeNull();

      expect(
        trackedFiles(sandbox, env),
        "git ls-files is index-based: the unstaged file is not in the listing, so it is never opened",
      ).toEqual(["tracked.ts"]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
