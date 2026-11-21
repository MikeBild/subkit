import { describe, expect, test } from "bun:test";
import { isNavShortcut, isTypingTarget } from "@ui/lib/nav-shortcut";

const key = (over: Partial<Parameters<typeof isNavShortcut>[0]> = {}) => ({
  key: "b",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  typing: false,
  ...over,
});

describe("nav shortcut", () => {
  test("⌘B and Ctrl+B toggle the navigation", () => {
    expect(isNavShortcut(key())).toBe(true);
    expect(isNavShortcut(key({ metaKey: false, ctrlKey: true, key: "B" }))).toBe(true);
  });

  test("while typing ⌘B stays bold", () => {
    expect(isNavShortcut(key({ typing: true }))).toBe(false);
    expect(isNavShortcut(key({ defaultPrevented: true }))).toBe(false);
  });

  test("other keys and modifier combinations do nothing", () => {
    expect(isNavShortcut(key({ key: "j" }))).toBe(false);
    expect(isNavShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isNavShortcut(key({ metaKey: false }))).toBe(false);
  });

  test("text fields and editors count as typing", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(
      isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
