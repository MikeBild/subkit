import { describe, expect, test } from "bun:test";
import { escapeMarkdownLinkText, escapeMarkdownTableCell } from "./markdown-escape.ts";

describe("escapeMarkdownTableCell", () => {
  test("escapes pipes so a value stays in its cell", () => {
    expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b");
  });

  test("escapes a backslash before a pipe so the pipe stays escaped", () => {
    expect(escapeMarkdownTableCell("a\\|b")).toBe("a\\\\\\|b");
    expect(escapeMarkdownTableCell("C:\\temp")).toBe("C:\\\\temp");
  });

  test("folds line breaks and runs of whitespace into one space", () => {
    expect(escapeMarkdownTableCell("  one\ntwo\t three  ")).toBe("one two three");
  });
});

describe("escapeMarkdownLinkText", () => {
  test("escapes brackets so the label cannot close the link", () => {
    expect(escapeMarkdownLinkText("a]b[c")).toBe("a\\]b\\[c");
  });

  test("escapes a backslash so an existing escape cannot unescape a bracket", () => {
    expect(escapeMarkdownLinkText("x\\]")).toBe("x\\\\\\]");
  });
});
