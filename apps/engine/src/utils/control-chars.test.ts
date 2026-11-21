import { describe, expect, test } from "bun:test";
import {
  hasCode,
  isC0,
  isC0OrDelete,
  isC0OrDeleteExceptTab,
  withoutCodes,
} from "./control-chars.ts";

const chr = (code: number) => String.fromCharCode(code);

describe("control character predicates", () => {
  test("isC0 covers U+0000 to U+001F only", () => {
    expect(isC0(0x00)).toBe(true);
    expect(isC0(0x1f)).toBe(true);
    expect(isC0(0x20)).toBe(false);
    expect(isC0(0x7f)).toBe(false);
  });

  test("isC0OrDelete adds U+007F", () => {
    expect(isC0OrDelete(0x7f)).toBe(true);
    expect(isC0OrDelete(0x80)).toBe(false);
    expect(isC0OrDelete(0x41)).toBe(false);
  });

  test("isC0OrDeleteExceptTab keeps the tab", () => {
    expect(isC0OrDeleteExceptTab(0x09)).toBe(false);
    expect(isC0OrDeleteExceptTab(0x0a)).toBe(true);
    expect(isC0OrDeleteExceptTab(0x08)).toBe(true);
    expect(isC0OrDeleteExceptTab(0x7f)).toBe(true);
  });
});

describe("hasCode and withoutCodes", () => {
  test("detect and strip matching code units", () => {
    const text = `a${chr(0)}b${chr(0x1f)}c${chr(0x7f)}d`;
    expect(hasCode(text, isC0)).toBe(true);
    expect(hasCode("plain", isC0OrDelete)).toBe(false);
    expect(withoutCodes(text, isC0OrDelete)).toBe("abcd");
    expect(withoutCodes(text, isC0)).toBe(`abc${chr(0x7f)}d`);
    expect(withoutCodes("übersicht.pdf", isC0OrDelete)).toBe("übersicht.pdf");
  });
});
