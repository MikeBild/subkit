// Unit tests for the path-input sanitizer used by file-path paste and
// `/knowledge` in the Ink composer. Pins the regression where invisible
// Unicode rode along with the user's pasted path.

import { describe, expect, test } from "bun:test";
import { renderSuspiciousCodepoints, sanitizePathInput } from "./path-input.ts";

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
    const raw = "/Users/mikebild/Projects/AI/ocpp.md/docs/OCPP-2.0.1.md";
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
