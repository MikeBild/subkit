// A source file with a NUL byte in it is invisible to text search.
//
// THE DEFECT, and it was live: `tests/contract/ci-workflows.test.ts` carried a
// raw 0x00 at offset 15200 — `join("\0")` written as the BYTE instead of the
// escape. `file(1)` then calls the file `data`, and every grep/ripgrep that
// skips binaries walks past it without a word. A verifier searching this
// repository for `WALK_BUDGET_MS` got an empty result and read it as "the code
// is missing" — from the one file whose job is to make CI's browser
// requirements visible.
//
// No gate was affected (every drift check is `git diff`-based), which is
// exactly why nothing caught it: the failure mode is not a wrong answer, it is
// a MISSING one, and a missing answer looks like a clean one.
//
// So: no tracked file in this repository holds a NUL byte, except the handful
// of formats that are binary by definition. The allowlist is by extension and
// deliberately tiny — a new file type is scanned by DEFAULT, and a genuinely
// binary newcomer is a one-line, visible decision here rather than a silent
// hole.
//
// It lives in tests/contract/ because CI's shard job runs `apps packages` only
// (LOCAL-SK-SCRIPTS-TESTS-NICHT-IN-CI). `bun run test:contract` runs this.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Formats whose bytes are not text. Everything else is scanned. */
const BINARY_SUFFIXES = [".gif", ".png", ".jpg", ".jpeg", ".ico", ".pdf", ".woff", ".woff2"];

function trackedFiles(): string[] {
  const listing = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
  return listing.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0);
}

/** Where the first NUL sits, in the terms a human fixes it with. */
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
    // A guard over an empty list passes for the wrong reason. Both halves: the
    // sweep is repository-sized, and it demonstrably includes the file the
    // defect was found in.
    expect(scanned.length).toBeGreaterThan(1_000);
    expect(scanned).toContain("tests/contract/ci-workflows.test.ts");
  });

  test("the detector finds a NUL where there is one", () => {
    // The counter-check, run rather than described — without it "no file has
    // one" could equally mean "nothing was looked at".
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
  });
});
