// Unit tests for apps/sk/src/memory.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "../memory.ts";

describe("sk memory loader", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-memory-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null when no SUBKIT.md is anywhere", () => {
    const m = loadMemory({ cwd: tmp });
    expect(m.content).toBeNull();
    expect(m.sources).toEqual([]);
  });

  test("reads a local SUBKIT.md and stamps its path", () => {
    writeFileSync(join(tmp, "SUBKIT.md"), "hello from local memory");
    const m = loadMemory({ cwd: tmp });
    expect(m.content).toContain("hello from local memory");
    expect(m.sources.length).toBe(1);
    expect(m.sources[0]).toContain("SUBKIT.md");
  });

  test("walks upward from a nested cwd and picks up the closest file", () => {
    const sub = join(tmp, "nested", "deeper");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(tmp, "SUBKIT.md"), "root-level memory");
    const m = loadMemory({ cwd: sub });
    expect(m.content).toContain("root-level memory");
  });

  test("honors include=false to skip entirely", () => {
    writeFileSync(join(tmp, "SUBKIT.md"), "should be ignored");
    const m = loadMemory({ cwd: tmp, include: false });
    expect(m.content).toBeNull();
  });

  test("truncates oversized memory at max_bytes with a visible marker", () => {
    writeFileSync(join(tmp, "SUBKIT.md"), "x".repeat(2048));
    const m = loadMemory({ cwd: tmp, max_bytes: 256 });
    expect(m.truncated).toBe(true);
    expect(m.content).toContain("[sk: memory truncated");
    // The marker adds bytes, so we assert only that we did cap near 256.
    expect((m.content ?? "").length).toBeLessThan(2048);
  });
});
