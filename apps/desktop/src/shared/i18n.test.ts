import { describe, expect, test } from "bun:test";
import { dictionary, messageKeys, resolveLocale, t } from "./i18n.ts";

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("i18n", () => {
  test("has German and English text with the same placeholders for every key", () => {
    const de = dictionary("de");
    const en = dictionary("en");
    for (const key of messageKeys()) {
      expect(de[key].trim().length).toBeGreaterThan(0);
      expect(en[key].trim().length).toBeGreaterThan(0);
      expect(placeholders(de[key])).toEqual(placeholders(en[key]));
    }
  });

  test("addresses the reader informally in German and uses typographic quotes", () => {
    for (const text of Object.values(dictionary("de"))) {
      expect(text).not.toMatch(/\b(Sie|Ihre?[mnrs]?)\b/);
      expect(text).not.toContain('"');
      expect(text).not.toContain("...");
      expect(text).not.toContain("!");
    }
  });

  test("uses curly quotes and no exclamation marks in English", () => {
    for (const text of Object.values(dictionary("en"))) {
      expect(text).not.toContain('"');
      expect(text).not.toContain("'");
      expect(text).not.toContain("!");
    }
  });

  test("fills placeholders and keeps unknown ones", () => {
    expect(t("de", "tray.needsYou", { count: 3 })).toBe("Braucht dich (3)");
    expect(t("en", "tray.needsYou", { count: 3 })).toBe("Needs you (3)");
    expect(t("en", "tray.needsYou")).toBe("Needs you ({count})");
  });

  test("follows the system language unless a language is set", () => {
    expect(resolveLocale("system", "de-DE")).toBe("de");
    expect(resolveLocale("system", "fr-FR")).toBe("en");
    expect(resolveLocale("en", "de-DE")).toBe("en");
  });
});
