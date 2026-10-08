import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const self = "scripts/__tests__/no-prod-references.test.ts";

describe("no installation-specific references", () => {
  test("the operator's domains appear in no tracked file", () => {
    const needle = ["mikebild", "(dev|com)"].join("\\.");
    let hits = "";
    try {
      hits = execFileSync("git", ["grep", "-nIE", needle, "--", ".", `:!${self}`], {
        cwd: root,
        encoding: "utf8",
      });
    } catch (error) {
      const err = error as { status?: number; stdout?: string };
      if (err.status === 1 && !err.stdout) return;
      throw error;
    }
    expect(hits, `installation-specific domain reference(s) found:\n${hits}`).toBe("");
  });
});
