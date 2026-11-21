import { describe, expect, test } from "bun:test";
import { APP_CASES, SHORTCUT_CASES } from "./blocked-apps.cases.ts";
import {
  ALWAYS_BLOCKED_KEYS,
  DARWIN_BLOCKED_SHORTCUTS,
  isBlockedShortcut,
  KEY_ALIASES,
  MODIFIER_ALIASES,
  normalizeChord,
  SYSTEM_KEY_ALIASES,
  WINDOWS_BLOCKED_SHORTCUTS,
} from "./shortcuts.ts";

describe("shortcut cases", () => {
  test("apps and shortcuts together reach 120 cases in both directions", () => {
    expect(APP_CASES.length + SHORTCUT_CASES.length).toBeGreaterThanOrEqual(120);
    expect(new Set(SHORTCUT_CASES.map((c) => c.id)).size).toBe(SHORTCUT_CASES.length);
    expect(SHORTCUT_CASES.some((c) => c.blocked)).toBe(true);
    expect(SHORTCUT_CASES.some((c) => !c.blocked)).toBe(true);
  });

  for (const c of SHORTCUT_CASES) {
    test(`${c.id} → ${c.blocked ? "blocked" : "allowed"}`, () => {
      expect(isBlockedShortcut(c.keys, c.os)).toBe(c.blocked);
    });
  }
});

describe("chord normalization", () => {
  test("orders modifiers and resolves aliases per system", () => {
    expect(normalizeChord("Shift+Cmd+3", "darwin")).toEqual({
      modifiers: ["shift", "cmd"],
      key: "3",
    });
    expect(normalizeChord(["⌥", "⌃", "⇧", "⌘", "⎋"], "darwin")).toEqual({
      modifiers: ["ctrl", "alt", "shift", "cmd"],
      key: "esc",
    });
    expect(normalizeChord("meta+x", "win32")).toEqual({ modifiers: ["win"], key: "x" });
    expect(normalizeChord("super+x", "darwin")).toEqual({ modifiers: ["cmd"], key: "x" });
    expect(normalizeChord("fn+globe+e", "darwin")).toEqual({ modifiers: ["fn"], key: "e" });
    expect(normalizeChord("ctl+^+a", "darwin")).toEqual({ modifiers: ["ctrl"], key: "a" });
    expect(normalizeChord("altgr+opt+q", "darwin")).toEqual({ modifiers: ["alt"], key: "q" });
    expect(normalizeChord("function+start+os+windows+⊞+command+x", "win32")).toEqual({
      modifiers: ["fn", "win"],
      key: "x",
    });
    expect(normalizeChord("cmd+shift", "darwin")).toEqual({
      modifiers: ["shift", "cmd"],
      key: "",
    });
  });

  test("maps key aliases", () => {
    const keys: readonly [string, string][] = [
      ["Escape", "esc"],
      ["Return", "enter"],
      ["↩", "enter"],
      ["⏎", "enter"],
      ["Spacebar", "space"],
      ["PrtScn", "printscreen"],
      ["prntscrn", "printscreen"],
      ["print", "printscreen"],
      ["print_screen", "printscreen"],
      ["Print Screen", "printscreen"],
      ["snapshot", "printscreen"],
      ["del", "delete"],
      ["ArrowLeft", "left"],
      ["arrowright", "right"],
      ["ArrowUp", "up"],
      ["arrowdown", "down"],
      ["←", "left"],
      ["↑", "up"],
      ["↓", "down"],
      ["backquote", "`"],
      ["grave", "`"],
      ["backtick", "`"],
      ["⇥", "tab"],
      ["⏏", "eject"],
      ["media_eject", "eject"],
      ["sleep", "power"],
      ["lock", "lock"],
      ["q", "q"],
    ];
    for (const [input, key] of keys) expect(normalizeChord([input], "darwin").key).toBe(key);
    expect(normalizeChord(["cmd", " "], "darwin").key).toBe("space");
    expect(normalizeChord(["cmd", ""], "darwin").key).toBe("space");
    expect(normalizeChord("cmd++", "darwin")).toEqual({ modifiers: ["cmd"], key: "+" });
  });

  test("power, eject, lock and print screen are blocked with any modifier", () => {
    for (const key of ["power", "eject", "lock", "printscreen"]) {
      expect(isBlockedShortcut([key], "darwin")).toBe(true);
      expect(isBlockedShortcut(["shift", key], "win32")).toBe(true);
    }
  });

  test("a digit with Control switches desktops only on macOS", () => {
    expect(isBlockedShortcut("ctrl+9", "darwin")).toBe(true);
    expect(isBlockedShortcut("ctrl+shift+1", "darwin")).toBe(true);
    expect(isBlockedShortcut("ctrl+f1", "darwin")).toBe(false);
    expect(isBlockedShortcut("ctrl", "darwin")).toBe(false);
    expect(isBlockedShortcut("cmd+1", "darwin")).toBe(false);
    expect(isBlockedShortcut("ctrl+10", "darwin")).toBe(false);
    expect(isBlockedShortcut("ctrl+x1", "darwin")).toBe(false);
  });
});

describe("the fixed shortcut lists", () => {
  test("every listed chord is blocked on its system", () => {
    for (const chord of DARWIN_BLOCKED_SHORTCUTS) {
      expect([chord, isBlockedShortcut(chord, "darwin")]).toEqual([chord, true]);
    }
    for (const chord of WINDOWS_BLOCKED_SHORTCUTS) {
      expect([chord, isBlockedShortcut(chord, "win32")]).toEqual([chord, true]);
    }
    for (const key of ALWAYS_BLOCKED_KEYS) expect(isBlockedShortcut(key, "darwin")).toBe(true);
  });

  test("every alias resolves to its modifier or key", () => {
    for (const alias of SYSTEM_KEY_ALIASES) {
      expect(normalizeChord([alias, "x"], "darwin").modifiers).toEqual(["cmd"]);
      expect(normalizeChord([alias, "x"], "win32").modifiers).toEqual(["win"]);
    }
    for (const [alias, modifier] of Object.entries(MODIFIER_ALIASES)) {
      expect(normalizeChord([alias.toUpperCase(), "x"], "darwin").modifiers).toEqual([modifier]);
    }
    for (const [alias, key] of Object.entries(KEY_ALIASES)) {
      expect(normalizeChord(["shift", ` ${alias.toUpperCase()} `], "darwin").key).toBe(key);
    }
  });
});
