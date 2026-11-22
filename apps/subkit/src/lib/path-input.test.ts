import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRegularFile,
  renderSuspiciousCodepoints,
  sanitizePathInput,
  statRegularFile,
} from "./path-input.ts";

describe("sanitizePathInput", () => {
  test("clean ASCII path passes through unchanged", () => {
    expect(sanitizePathInput("/Users/me/file.md")).toBe("/Users/me/file.md");
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizePathInput("  /tmp/x.md  ")).toBe("/tmp/x.md");
  });

  test("strips ZWSP (U+200B) injected by Notion/Confluence paste", () => {
    const raw = "/Users/me/file\u200B.md";
    expect(sanitizePathInput(raw)).toBe("/Users/me/file.md");
  });

  test("strips BOM (U+FEFF) and ZWJ/ZWNJ", () => {
    const raw = "\uFEFF/tmp/\u200Cfile\u200D.md";
    expect(sanitizePathInput(raw)).toBe("/tmp/file.md");
  });

  test("strips bidi marks (LRM U+200E, RLM U+200F)", () => {
    expect(sanitizePathInput("/a\u200E/b\u200F.md")).toBe("/a/b.md");
  });

  test("normalises NBSP (U+00A0) to a regular space so embedded spaces survive", () => {
    expect(sanitizePathInput("/tmp/with\u00A0space.md")).toBe("/tmp/with space.md");
  });

  test("the real reported path round-trips clean when no invisibles are present", () => {
    const raw = "/Users/dev/Documents/specs/OCPP-2.0.1.md";
    expect(sanitizePathInput(raw)).toBe(raw);
  });
});

describe("renderSuspiciousCodepoints", () => {
  test("empty string for clean ASCII", () => {
    expect(renderSuspiciousCodepoints("/tmp/x.md")).toBe("");
  });

  test("lists hex codepoints when an invisible char is present", () => {
    const out = renderSuspiciousCodepoints("a\u200B");
    expect(out).toContain("codepoints");
    expect(out).toContain("200b");
  });

  test("detects NBSP separately from the zero-width strip set", () => {
    const out = renderSuspiciousCodepoints("a\u00A0b");
    expect(out).toContain("a0");
  });
});

describe("readRegularFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "sk-path-input-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads the bytes of a regular file", () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    const read = readRegularFile(file);
    expect(read.kind === "file" ? read.bytes.toString("utf8") : read.kind).toBe("hello");
  });

  test("reports a missing file instead of throwing", () => {
    expect(readRegularFile(join(dir, "nope.txt"))).toEqual({ kind: "missing" });
    expect(readRegularFile(join(dir, "nope", "deeper.txt"))).toEqual({ kind: "missing" });
  });

  test("reports a directory as not a file", () => {
    expect(readRegularFile(dir)).toEqual({ kind: "not_file" });
  });

  test("follows a symlink by default and refuses it on request", () => {
    if (process.platform === "win32") return;
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "via link");
    symlinkSync(target, link);
    expect(readRegularFile(link).kind).toBe("file");
    expect(readRegularFile(link, { followSymlinks: false })).toEqual({ kind: "not_file" });
  });
});

describe("statRegularFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "subkit-path-stat-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reports the size of a regular file without reading it", () => {
    const file = join(dir, "big.bin");
    writeFileSync(file, Buffer.alloc(4096));
    expect(statRegularFile(file)).toEqual({ kind: "file", size: 4096 });
  });

  test("reports missing paths and directories", () => {
    expect(statRegularFile(join(dir, "nope"))).toEqual({ kind: "missing" });
    expect(statRegularFile(dir)).toEqual({ kind: "not_file" });
  });
});
