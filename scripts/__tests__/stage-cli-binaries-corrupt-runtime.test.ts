import { describe, expect, test } from "bun:test";
import { bunCacheDirCandidates, corruptRuntimeFromStderr } from "../stage-cli-binaries.ts";

const REAL_FAILURE = [
  "#15 4.529 Failed to extract executable for 'bun-linux-aarch64-v1.3.14'. The download may be incomplete.",
  "#15 4.529 bun build failed for bun-linux-arm64 (exit 1)",
].join("\n");

describe("corruptRuntimeFromStderr", () => {
  test("names the cached runtime from a real nightly failure", () => {
    expect(corruptRuntimeFromStderr(REAL_FAILURE)).toBe("bun-linux-aarch64-v1.3.14");
  });

  test("an ordinary compile error yields nothing to purge", () => {
    const compileError = [
      'error: Could not resolve: "./missing.ts"',
      "bun build failed for bun-linux-x64 (exit 1)",
    ].join("\n");
    expect(corruptRuntimeFromStderr(compileError)).toBeNull();
  });

  test("the vaguer half of the message alone is not enough to act on", () => {
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
    const dirs = bunCacheDirCandidates({} as NodeJS.ProcessEnv);
    expect(dirs).toContain("/root/.bun/install/cache");
  });

  test("duplicates collapse", () => {
    const dirs = bunCacheDirCandidates({ HOME: "/root" } as NodeJS.ProcessEnv);
    expect(dirs.filter((d) => d === "/root/.bun/install/cache")).toHaveLength(1);
  });
});
