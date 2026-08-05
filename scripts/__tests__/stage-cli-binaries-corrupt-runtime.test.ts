// The corrupt-runtime signature that makes a flaky download self-repairing.
//
// A cross-compile needs the target platform's bun runtime, which `bun build`
// fetches and caches itself. A truncated fetch leaves the broken archive in the
// cache, so every later attempt fails identically — one bad download became
// four consecutive red nightlies. The staging script now removes exactly the
// artifact the compiler named and retries once.
//
// That repair hangs entirely on reading a message bun owns. If the wording
// moves, `corruptRuntimeFromStderr` returns null, no cache entry is removed, no
// retry happens, and the build goes back to failing forever — silently, because
// nothing about that path is otherwise observable. This test holds the string.

import { describe, expect, test } from "bun:test";
import { bunCacheDirCandidates, corruptRuntimeFromStderr } from "../stage-cli-binaries.ts";

// Copied verbatim from the 2026-08-04 nightly (`docker e2e (full track)`).
const REAL_FAILURE = [
  "#15 4.529 Failed to extract executable for 'bun-linux-aarch64-v1.3.14'. The download may be incomplete.",
  "#15 4.529 bun build failed for bun-linux-arm64 (exit 1)",
].join("\n");

describe("corruptRuntimeFromStderr", () => {
  test("names the cached runtime from a real nightly failure", () => {
    // The name must come back exactly as bun writes it — it is used as a
    // directory name under the bun cache, so a near-miss removes nothing.
    expect(corruptRuntimeFromStderr(REAL_FAILURE)).toBe("bun-linux-aarch64-v1.3.14");
  });

  test("an ordinary compile error yields nothing to purge", () => {
    // Without this the retry would fire on genuine build breakage, turning a
    // clear failure into a slow one and deleting a cache entry for no reason.
    const compileError = [
      'error: Could not resolve: "./missing.ts"',
      "bun build failed for bun-linux-x64 (exit 1)",
    ].join("\n");
    expect(corruptRuntimeFromStderr(compileError)).toBeNull();
  });

  test("the vaguer half of the message alone is not enough to act on", () => {
    // bun also prints "The download may be incomplete." on its own in other
    // contexts. Matching that sentence without a named artifact would leave
    // nothing to delete, so it must not be treated as a repairable signal.
    expect(corruptRuntimeFromStderr("The download may be incomplete.")).toBeNull();
  });
});

describe("bunCacheDirCandidates", () => {
  test("bun's own override wins, then BUN_INSTALL, then HOME", () => {
    const dirs = bunCacheDirCandidates({
      BUN_INSTALL_CACHE_DIR: "/explicit/cache",
      BUN_INSTALL: "/opt/bun",
      HOME: "/home/dev",
    } as NodeJS.ProcessEnv);
    expect(dirs[0]).toBe("/explicit/cache");
    expect(dirs).toContain("/opt/bun/install/cache");
    expect(dirs).toContain("/home/dev/.bun/install/cache");
  });

  test("an unset HOME still yields the builder's root cache", () => {
    // The Docker builder stage runs as root and does not always export HOME.
    // A single `HOME`-derived guess resolved to a path that was never written,
    // which is how the purge came to report success while removing nothing.
    const dirs = bunCacheDirCandidates({} as NodeJS.ProcessEnv);
    expect(dirs).toContain("/root/.bun/install/cache");
  });

  test("duplicates collapse", () => {
    const dirs = bunCacheDirCandidates({ HOME: "/root" } as NodeJS.ProcessEnv);
    expect(dirs.filter((d) => d === "/root/.bun/install/cache")).toHaveLength(1);
  });
});
