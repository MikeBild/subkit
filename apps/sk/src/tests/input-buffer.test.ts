// Pure unit tests for the cursor-aware input buffer. Every edit is
// deterministic so these run with plain `bun test` — no ink or React.

import { describe, expect, test } from "bun:test";
import {
  apply,
  buffer,
  cursorPosition,
  EMPTY_BUFFER,
  type InputBuffer,
  lineEnd,
  lineStart,
  nextWordBoundary,
  prevWordBoundary,
  splitLines,
} from "../repl/input-buffer.ts";

function b(value: string, cursor?: number): InputBuffer {
  return { value, cursor: cursor ?? value.length };
}

describe("input-buffer: insert", () => {
  test("appends to the end", () => {
    expect(apply(EMPTY_BUFFER, { type: "insert", text: "hi" })).toEqual({
      value: "hi",
      cursor: 2,
    });
  });

  test("inserts at the cursor position", () => {
    expect(apply(b("ac", 1), { type: "insert", text: "b" })).toEqual({
      value: "abc",
      cursor: 2,
    });
  });

  test("empty insert is a no-op", () => {
    const s = b("x", 1);
    expect(apply(s, { type: "insert", text: "" })).toEqual(s);
  });
});

describe("input-buffer: deletePrev / deleteNext", () => {
  test("deletePrev at offset 0 is a no-op", () => {
    expect(apply(b(""), { type: "deletePrev" })).toEqual(EMPTY_BUFFER);
    expect(apply(b("abc", 0), { type: "deletePrev" })).toEqual(b("abc", 0));
  });

  test("deletePrev removes the char before the cursor", () => {
    expect(apply(b("abc", 2), { type: "deletePrev" })).toEqual({ value: "ac", cursor: 1 });
  });

  test("deleteNext at end-of-buffer is a no-op", () => {
    expect(apply(b("abc"), { type: "deleteNext" })).toEqual(b("abc"));
  });

  test("deleteNext removes the char after the cursor", () => {
    expect(apply(b("abc", 1), { type: "deleteNext" })).toEqual({ value: "ac", cursor: 1 });
  });
});

describe("input-buffer: word-wise kill + move", () => {
  test("killPrevWord with no word behind the cursor is a no-op", () => {
    expect(apply(b(""), { type: "killPrevWord" })).toEqual(EMPTY_BUFFER);
  });

  test("killPrevWord removes the word to the left", () => {
    expect(apply(b("hello world"), { type: "killPrevWord" })).toEqual({
      value: "hello ",
      cursor: 6,
    });
  });

  test("killPrevWord eats trailing separators first", () => {
    expect(apply(b("foo   "), { type: "killPrevWord" })).toEqual(EMPTY_BUFFER);
  });

  test("killNextWord removes the word to the right", () => {
    expect(apply(b("hello world", 0), { type: "killNextWord" })).toEqual({
      value: " world",
      cursor: 0,
    });
  });

  test("moveWordLeft jumps to the previous word start", () => {
    const s = apply(b("foo bar baz"), { type: "moveWordLeft" });
    expect(s.cursor).toBe(8); // `b` of `baz`
  });

  test("moveWordRight jumps to the next word start", () => {
    const s = apply(b("foo bar baz", 0), { type: "moveWordRight" });
    expect(s.cursor).toBe(3);
  });

  test("moveWordLeft at offset 0 is a no-op", () => {
    expect(apply(b("foo", 0), { type: "moveWordLeft" }).cursor).toBe(0);
  });

  test("moveWordRight at end-of-buffer is a no-op", () => {
    expect(apply(b("foo"), { type: "moveWordRight" }).cursor).toBe(3);
  });

  test("prevWordBoundary helper returns the correct offset", () => {
    expect(prevWordBoundary("foo bar", 7)).toBe(4);
    expect(prevWordBoundary("foo   ", 6)).toBe(0);
    expect(prevWordBoundary("", 0)).toBe(0);
  });

  test("nextWordBoundary helper returns the correct offset", () => {
    expect(nextWordBoundary("foo bar", 0)).toBe(3);
    expect(nextWordBoundary("   foo", 0)).toBe(6);
    expect(nextWordBoundary("foo", 3)).toBe(3);
  });
});

describe("input-buffer: cursor navigation", () => {
  test("moveLeft stops at 0", () => {
    expect(apply(b("ab", 0), { type: "moveLeft" }).cursor).toBe(0);
  });

  test("moveRight stops at length", () => {
    expect(apply(b("ab"), { type: "moveRight" }).cursor).toBe(2);
  });

  test("moveHome jumps to 0", () => {
    expect(apply(b("ab"), { type: "moveHome" }).cursor).toBe(0);
  });

  test("moveEnd jumps to length", () => {
    expect(apply(b("ab", 0), { type: "moveEnd" }).cursor).toBe(2);
  });

  test("moveLineStart jumps to the start of the current line", () => {
    expect(apply(b("one\ntwo", 5), { type: "moveLineStart" }).cursor).toBe(4);
    expect(apply(b("one", 2), { type: "moveLineStart" }).cursor).toBe(0);
  });

  test("moveLineEnd jumps to the end of the current line", () => {
    expect(apply(b("one\ntwo", 1), { type: "moveLineEnd" }).cursor).toBe(3);
    expect(apply(b("one\ntwo", 5), { type: "moveLineEnd" }).cursor).toBe(7);
  });
});

describe("input-buffer: kill / clear / newline", () => {
  test("killToEnd deletes to end of line", () => {
    expect(apply(b("abc def", 3), { type: "killToEnd" })).toEqual({ value: "abc", cursor: 3 });
  });

  test("killToEnd at end of line eats the newline", () => {
    expect(apply(b("abc\ndef", 3), { type: "killToEnd" })).toEqual({
      value: "abcdef",
      cursor: 3,
    });
  });

  test("killLine wipes the buffer", () => {
    expect(apply(b("anything"), { type: "killLine" })).toEqual(EMPTY_BUFFER);
  });

  test("newline inserts `\\n` at the cursor", () => {
    expect(apply(b("ab"), { type: "newline" })).toEqual({ value: "ab\n", cursor: 3 });
  });

  test("clear resets to empty", () => {
    expect(apply(b("x"), { type: "clear" })).toEqual(EMPTY_BUFFER);
  });

  test("set replaces value and places cursor at end by default", () => {
    expect(apply(EMPTY_BUFFER, { type: "set", value: "hello" })).toEqual({
      value: "hello",
      cursor: 5,
    });
  });

  test("set honors an explicit cursor", () => {
    expect(apply(EMPTY_BUFFER, { type: "set", value: "hello", cursor: 2 })).toEqual({
      value: "hello",
      cursor: 2,
    });
  });
});

describe("input-buffer: helpers", () => {
  test("buffer() seeds cursor at end", () => {
    expect(buffer("abc")).toEqual({ value: "abc", cursor: 3 });
  });

  test("splitLines keeps an empty row for empty input", () => {
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\n")).toEqual(["a", ""]);
  });

  test("cursorPosition reports row + column for single line", () => {
    expect(cursorPosition(b("abc", 2))).toEqual({ row: 0, column: 2 });
  });

  test("cursorPosition handles multi-line offsets", () => {
    expect(cursorPosition(b("one\ntwo", 5))).toEqual({ row: 1, column: 1 });
  });

  test("lineStart and lineEnd work on single + multi-line input", () => {
    expect(lineStart("abc", 2)).toBe(0);
    expect(lineEnd("abc", 2)).toBe(3);
    expect(lineStart("a\nb\nc", 4)).toBe(4);
    expect(lineEnd("a\nb\nc", 2)).toBe(3);
  });
});
