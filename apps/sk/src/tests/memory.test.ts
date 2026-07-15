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

  test("returns null when no SK.md is anywhere", () => {
    const m = loadMemory({ cwd: tmp });
    expect(m.content).toBeNull();
    expect(m.sources).toEqual([]);
  });

  test("reads a local SK.md and stamps its path", () => {
    writeFileSync(join(tmp, "SK.md"), "hello from local memory");
    const m = loadMemory({ cwd: tmp });
    expect(m.content).toContain("hello from local memory");
    expect(m.sources.length).toBe(1);
    expect(m.sources[0]).toContain("SK.md");
  });

  test("walks upward from a nested cwd and picks up the closest file", () => {
    const sub = join(tmp, "nested", "deeper");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(tmp, "SK.md"), "root-level memory");
    const m = loadMemory({ cwd: sub });
    expect(m.content).toContain("root-level memory");
  });

  test("honors include=false to skip entirely", () => {
    writeFileSync(join(tmp, "SK.md"), "should be ignored");
    const m = loadMemory({ cwd: tmp, include: false });
    expect(m.content).toBeNull();
  });

  test("truncates oversized memory at max_bytes with a visible marker", () => {
    writeFileSync(join(tmp, "SK.md"), "x".repeat(2048));
    const m = loadMemory({ cwd: tmp, max_bytes: 256 });
    expect(m.truncated).toBe(true);
    expect(m.content).toContain("[sk: memory truncated");
    // The marker adds bytes, so we assert only that we did cap near 256.
    expect((m.content ?? "").length).toBeLessThan(2048);
  });

  test("over-cap merge drops the FAR section and keeps the cwd-closest content", () => {
    // Regression: the old implementation sliced the merged string's
    // HEAD, which discarded exactly the highest-priority (closest)
    // section first. The far ancestor must be the one reduced to a
    // dropped-marker; the nested project content must survive intact.
    const sub = join(tmp, "nested");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(tmp, "SK.md"), `FAR-ANCESTOR ${"a".repeat(600)}`);
    writeFileSync(join(sub, "SK.md"), `CLOSE-PROJECT ${"b".repeat(200)}`);
    const m = loadMemory({ cwd: sub, max_bytes: 512 });
    expect(m.truncated).toBe(true);
    expect(m.content).toContain("CLOSE-PROJECT");
    expect(m.content).toContain("bbbb");
    expect(m.content).not.toContain("aaaa");
    expect(m.content).toContain("[sk: section dropped");
  });

  test("budget is measured in UTF-8 bytes, not UTF-16 code units", () => {
    // 300 umlauts = 300 chars but 600 UTF-8 bytes; a char-counting cap
    // of 512 would NOT truncate. Clipping must also never split a
    // multi-byte code point (no replacement char in the output).
    writeFileSync(join(tmp, "SK.md"), "ä".repeat(300));
    const m = loadMemory({ cwd: tmp, max_bytes: 512 });
    expect(m.truncated).toBe(true);
    expect(m.content).not.toContain("�");
    expect(Buffer.byteLength(m.content ?? "", "utf8")).toBeLessThan(700);
  });

  test("each section header carries the source path and a content hash", () => {
    writeFileSync(join(tmp, "SK.md"), "hashed content");
    const m = loadMemory({ cwd: tmp });
    expect(m.content).toMatch(/# Memory from .*SK\.md \(sha256:[0-9a-f]{12}\)/);
  });
});
