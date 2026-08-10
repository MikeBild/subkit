import { describe, expect, test } from "bun:test";
import { CATALOGS, type TranslationKey, translate } from "@/lib/i18n";
import {
  createLocaleStore,
  LOCALE_STORAGE_KEY,
  type LocaleEnvironment,
  resolveLocale,
} from "@/lib/locale-store";
import { statusLabel } from "@/lib/status-label";

function environment(stored: string | null, languages: string[]) {
  const storage = new Map<string, string>();
  if (stored) storage.set(LOCALE_STORAGE_KEY, stored);
  const applied: string[] = [];
  const env: LocaleEnvironment = {
    read: (key) => storage.get(key) ?? null,
    write: (key, value) => storage.set(key, value),
    remove: (key) => storage.delete(key),
    languages: () => languages,
    apply: (locale) => applied.push(locale),
  };
  return { env, storage, applied };
}

describe("cockpit i18n", () => {
  test("keeps English and German catalogs complete", () => {
    const english = Object.keys(CATALOGS.en).sort();
    expect(Object.keys(CATALOGS.de).sort()).toEqual(english);
    for (const key of english as TranslationKey[]) {
      expect(translate("en", key)).not.toBe(key);
      expect(translate("de", key)).not.toBe(key);
    }
  });

  test("detects German and otherwise falls back to English", () => {
    expect(resolveLocale(["de-DE", "en-US"])).toBe("de");
    expect(resolveLocale(["fr-FR"])).toBe("en");
  });

  test("localizes known statuses and humanizes future values", () => {
    expect(statusLabel((key) => translate("de", key), "awaiting_input")).toBe("Wartet auf Eingabe");
    expect(statusLabel((key) => translate("en", key), "future_state")).toBe("future state");
  });

  test("supports automatic detection and persistent manual selection", () => {
    const fake = environment(null, ["de-DE"]);
    const store = createLocaleStore(fake.env);
    expect(store.snapshot()).toEqual({ preference: "auto", locale: "de" });
    store.set("en");
    expect(fake.storage.get(LOCALE_STORAGE_KEY)).toBe("en");
    expect(store.snapshot()).toEqual({ preference: "en", locale: "en" });
    store.set("auto");
    expect(fake.storage.has(LOCALE_STORAGE_KEY)).toBe(false);
    expect(store.snapshot()).toEqual({ preference: "auto", locale: "de" });
  });

  test("invalid stored preferences safely return to automatic mode", () => {
    const fake = environment("klingon", ["de"]);
    expect(createLocaleStore(fake.env).snapshot()).toEqual({ preference: "auto", locale: "de" });
  });
});
