import { describe, expect, test } from "bun:test";
import { firstGrapheme } from "./grapheme.ts";

describe("firstGrapheme", () => {
  test("returns the first ASCII char", () => {
    expect(firstGrapheme("commit and push it")).toBe("c");
  });

  test("returns empty string for empty input", () => {
    expect(firstGrapheme("")).toBe("");
  });

  test("treats a ZWJ emoji as a single grapheme", () => {
    // family emoji: man + ZWJ + woman + ZWJ + boy
    const family = "\u{1F468}‍\u{1F469}‍\u{1F466}";
    expect(firstGrapheme(`${family} party`)).toBe(family);
  });

  test("treats a flag emoji as a single grapheme", () => {
    const flag = "\u{1F1E9}\u{1F1EA}"; // German flag
    expect(firstGrapheme(`${flag}ploy`)).toBe(flag);
  });

  test("treats a CJK character as one grapheme", () => {
    expect(firstGrapheme("コミット")).toBe("コ");
  });
});
