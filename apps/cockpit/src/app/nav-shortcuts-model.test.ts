import { describe, expect, test } from "bun:test";
import {
  navShortcutAria,
  navShortcutIndex,
  navShortcutLabel,
  navShortcutTarget,
} from "./nav-shortcuts-model";

const key = (
  k: string,
  extra: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

const PATHS = [
  "/",
  "/chat",
  "/workflows",
  "/tasks",
  "/connectors",
  "/intake",
  "/knowledge",
  "/skills",
  "/files",
  "/usage",
];

describe("navShortcutTarget", () => {
  test("⌘1 to ⌘9 open the first nine navigation entries in order inside the app window", () => {
    for (let n = 1; n <= 9; n += 1)
      expect(
        navShortcutTarget({
          event: key(String(n), { metaKey: true }),
          mac: true,
          appWindow: true,
          paths: PATHS,
        }),
      ).toBe(PATHS[n - 1] ?? null);
  });

  test("a browser tab keeps ⌘1–9 for switching tabs", () => {
    expect(
      navShortcutTarget({
        event: key("1", { metaKey: true }),
        mac: true,
        appWindow: false,
        paths: PATHS,
      }),
    ).toBeNull();
  });

  test("a number without an entry does nothing", () => {
    expect(
      navShortcutTarget({
        event: key("4", { metaKey: true }),
        mac: true,
        appWindow: true,
        paths: ["/", "/chat"],
      }),
    ).toBeNull();
  });
});

describe("navShortcutIndex", () => {
  test("uses ⌘ on a Mac and Ctrl elsewhere", () => {
    expect(navShortcutIndex(key("2", { metaKey: true }), true)).toBe(1);
    expect(navShortcutIndex(key("2", { ctrlKey: true }), true)).toBeNull();
    expect(navShortcutIndex(key("2", { ctrlKey: true }), false)).toBe(1);
    expect(navShortcutIndex(key("2", { metaKey: true }), false)).toBeNull();
  });

  test("leaves ⌘B, ⌘J, ⌘, ⌘0 and shifted or alt combinations alone", () => {
    for (const k of ["b", "j", ",", "0"])
      expect(navShortcutIndex(key(k, { metaKey: true }), true)).toBeNull();
    expect(navShortcutIndex(key("1", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(navShortcutIndex(key("1", { metaKey: true, altKey: true }), true)).toBeNull();
    expect(navShortcutIndex(key("1"), true)).toBeNull();
  });
});

describe("navShortcutLabel", () => {
  test("names the shortcut for the first nine entries only", () => {
    expect(navShortcutLabel(0, true)).toBe("⌘1");
    expect(navShortcutLabel(8, false)).toBe("Ctrl+9");
    expect(navShortcutLabel(9, true)).toBeNull();
    expect(navShortcutAria(2)).toBe("Meta+3 Control+3");
    expect(navShortcutAria(9)).toBeNull();
  });
});
