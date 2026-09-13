// Unit tests for apps/sk/src/mentions.ts.
//
// We don't stand up a real EngineClient here — the `@workflow:` and
// `@execution:` paths are covered in the journey tests which drive
// the compiled binary against a live engine.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveMentions } from "../mentions.ts";

describe("sk @mention resolver", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-mentions-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("inlines an allowed file and appends it to the prompt", async () => {
    writeFileSync(join(tmp, "notes.md"), "remember: be concise");
    const r = await resolveMentions("what did I say? @notes.md", { cwd: tmp });
    expect(r.warnings).toEqual([]);
    expect(r.artifacts.length).toBe(1);
    expect(r.artifacts[0]?.body).toContain("be concise");
    expect(r.prompt).toContain("## File notes.md");
  });

  test("rejects path traversal attempts", async () => {
    const r = await resolveMentions("@../etc/passwd", { cwd: tmp });
    expect(r.warnings[0]).toContain("path traversal");
    expect(r.artifacts.length).toBe(0);
  });

  test("rejects files outside cwd and additionalDirectories", async () => {
    const outside = mkdtempSync(join(tmpdir(), "sk-outside-"));
    writeFileSync(join(outside, "secret.txt"), "do not read");
    const r = await resolveMentions(`@${join(outside, "secret.txt")}`, { cwd: tmp });
    expect(r.warnings[0]).toContain("outside cwd");
    rmSync(outside, { recursive: true, force: true });
  });

  test("accepts files in additionalDirectories", async () => {
    const extra = mkdirSync(join(tmp, "extras"), { recursive: true });
    void extra;
    writeFileSync(join(tmp, "extras", "hint.txt"), "from the extras dir");
    const r = await resolveMentions("@extras/hint.txt", {
      cwd: tmp,
      additionalDirectories: ["extras"],
    });
    expect(r.warnings).toEqual([]);
    expect(r.artifacts[0]?.body).toContain("from the extras dir");
  });

  test("truncates oversized files with a marker", async () => {
    writeFileSync(join(tmp, "big.txt"), "y".repeat(2048));
    const r = await resolveMentions("@big.txt", { cwd: tmp, maxBytes: 256 });
    expect(r.artifacts[0]?.body).toContain("[sk: file truncated");
  });

  test("missing file emits a warning", async () => {
    const r = await resolveMentions("@does-not-exist.txt", { cwd: tmp });
    expect(r.warnings[0]).toContain("not found");
    expect(r.artifacts.length).toBe(0);
  });
});
