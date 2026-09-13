import { describe, expect, test } from "bun:test";

import { findSlashCommandPositions, spanAtCursor } from "../repl/slash/findPositions.ts";

describe("findSlashCommandPositions", () => {
  test("matches a single slash at start", () => {
    expect(findSlashCommandPositions("/help")).toEqual([{ start: 0, end: 5, name: "help" }]);
  });

  test("matches just the slash (no name yet)", () => {
    expect(findSlashCommandPositions("/")).toEqual([{ start: 0, end: 1, name: "" }]);
  });

  test("matches after whitespace, not mid-word", () => {
    expect(findSlashCommandPositions("hello /world")).toEqual([
      { start: 6, end: 12, name: "world" },
    ]);
    expect(findSlashCommandPositions("a/b")).toEqual([]);
  });

  test("matches after newline", () => {
    expect(findSlashCommandPositions("hi\n/clear")).toEqual([{ start: 3, end: 9, name: "clear" }]);
  });

  test("supports hyphens, underscores, and digits in command names", () => {
    expect(findSlashCommandPositions("/run_v2 /find-thing")).toEqual([
      { start: 0, end: 7, name: "run_v2" },
      { start: 8, end: 19, name: "find-thing" },
    ]);
  });

  test("returns empty for plain text without slashes", () => {
    expect(findSlashCommandPositions("just a message")).toEqual([]);
  });
});

describe("spanAtCursor", () => {
  test("returns the span containing the cursor", () => {
    const buf = "/help me";
    expect(spanAtCursor(buf, 0)?.name).toBe("help");
    expect(spanAtCursor(buf, 3)?.name).toBe("help");
    expect(spanAtCursor(buf, 5)?.name).toBe("help"); // at end of token is OK
  });

  test("returns null when cursor is outside any slash token", () => {
    expect(spanAtCursor("/help me", 7)).toBeNull(); // past the slash token
    expect(spanAtCursor("hello", 2)).toBeNull(); // no slash anywhere
  });
});
