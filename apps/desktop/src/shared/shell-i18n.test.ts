import { describe, expect, test } from "bun:test";
import { clockLabel, shellDictionary, shellMessageKeys, st } from "./shell-i18n.ts";
import { isShellUrl, SHELL_VIEWS, shellUrl, shellViewOf } from "./shell-ipc.ts";

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("shell texts", () => {
  test("German and English for every key with the same placeholders", () => {
    const de = shellDictionary("de");
    const en = shellDictionary("en");
    for (const key of shellMessageKeys()) {
      expect(de[key].trim().length).toBeGreaterThan(0);
      expect(en[key].trim().length).toBeGreaterThan(0);
      expect(placeholders(de[key])).toEqual(placeholders(en[key]));
    }
  });

  test("German uses du, typographic quotes and no exclamation marks", () => {
    for (const text of Object.values(shellDictionary("de"))) {
      expect(text).not.toMatch(/\b(Sie|Ihre?[mnrs]?)\b/);
      expect(text).not.toContain('"');
      expect(text).not.toContain("...");
      expect(text).not.toContain("!");
    }
  });

  test("English uses curly quotes and no exclamation marks", () => {
    for (const text of Object.values(shellDictionary("en"))) {
      expect(text).not.toContain('"');
      expect(text).not.toContain("'");
      expect(text).not.toContain("!");
    }
  });

  test("fills placeholders", () => {
    expect(st("de", "drop.lead.many", { count: 3 })).toBe("3 Dateien sind angekommen.");
    expect(st("en", "quick.keys", { mod: "⌘" })).toBe("⌘ ↩ sends · Esc closes");
  });

  test("formats the clock per language", () => {
    const at = new Date(2026, 10, 21, 15, 5);
    expect(clockLabel("de", at)).toBe("15:05");
    expect(clockLabel("en", at)).toBe("03:05 PM");
  });
});

describe("shell page address", () => {
  test("one page, the view in the fragment", () => {
    for (const view of SHELL_VIEWS) {
      expect(isShellUrl(shellUrl(view))).toBe(true);
      expect(shellViewOf(shellUrl(view))).toBe(view);
    }
    expect(shellViewOf("subkit-app://shell/shell.html#other")).toBeNull();
    expect(isShellUrl("subkit-app://shell/index.html")).toBe(false);
    expect(isShellUrl("https://shell/shell.html")).toBe(false);
  });
});
