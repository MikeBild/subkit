import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { CATALOGS, translate, type TranslationKey } from "@/lib/i18n";
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
  test("rejects duplicate source keys before object evaluation can hide them", () => {
    const source = readFileSync(new URL("../lib/i18n.ts", import.meta.url), "utf8");
    for (const [name, block] of [
      [
        "EN",
        source.slice(source.indexOf("const EN = {"), source.indexOf("export type TranslationKey")),
      ],
      ["DE", source.slice(source.indexOf("const DE:"), source.indexOf("export const CATALOGS"))],
    ] as const) {
      const keys = [...block.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1]);
      const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
      expect(duplicates, `${name} contains duplicate keys`).toEqual([]);
    }
  });

  test("keeps English and German catalogs complete", () => {
    const english = Object.keys(CATALOGS.en).sort();
    expect(Object.keys(CATALOGS.de).sort()).toEqual(english);
    for (const key of english as TranslationKey[]) {
      expect(translate("en", key)).not.toBe(key);
      expect(translate("de", key)).not.toBe(key);
      const placeholders = (value: string) =>
        [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      expect(placeholders(CATALOGS.de[key])).toEqual(placeholders(CATALOGS.en[key]));
    }
  });

  test("detects German and otherwise falls back to English", () => {
    expect(resolveLocale(["de-DE", "en-US"])).toBe("de");
    expect(resolveLocale(["fr-FR"])).toBe("en");
  });

  test("localizes known statuses and safely labels future values", () => {
    expect(statusLabel((key) => translate("de", key), "awaiting_input")).toBe("Wartet auf Eingabe");
    expect(statusLabel((key) => translate("en", key), "future_state")).toBe("Unknown");
  });

  test("gives every status the engine can persist a word of its own", () => {
    // The state vocabulary forbids "unknown": a value the engine stores must
    // read as a word, not as a placeholder. This list is every state that can
    // reach an operator, not only the execution and conversation ones — the
    // catalogue vocabulary below used to fall through to the placeholder, and
    // it did so twice per page, because the state column and the filter
    // dropdown resolve the same values through this one function.
    const persisted = [
      // executions
      "queued",
      "running",
      "succeeded",
      "failed",
      "aborted",
      "timed_out",
      // conversations
      "active",
      "awaiting_input",
      "committed",
      "abandoned",
      // decisions
      "proposed",
      "applied",
      "rejected",
      "superseded",
      "approved",
      // workflow and skill lifecycle
      "draft",
      "archived",
      // connectors
      "enabled",
      "disabled",
      "ok",
      "degraded",
      "needs_update",
      "needs_reauth",
      "needs_attention",
      // knowledge sources
      "inactive",
      "processing",
      "error",
      // files
      "pending",
      "uploading",
      "scanning",
      "ready",
      "expired",
      // notification severity
      "debug",
      "info",
      "warn",
      "critical",
      // file scan verdicts
      "clean",
      "infected",
      "noop",
      "timeout",
    ];
    for (const status of persisted) {
      for (const locale of ["en", "de"] as const) {
        const label = statusLabel((key) => translate(locale, key), status);
        expect(label).not.toBe(translate(locale, "status.unknown"));
      }
    }
  });

  test("localizes every built-in role exposed by administration", () => {
    for (const key of [
      "role.admin",
      "role.member",
      "role.enduser",
      "role.metricsScraper",
      "role.portalTokenUser",
      "access.roleDescription.admin",
      "access.roleDescription.member",
      "access.roleDescription.enduser",
      "access.roleDescription.metricsScraper",
      "access.roleDescription.portalTokenUser",
    ] as const) {
      expect(translate("en", key)).not.toBe("Unknown");
      expect(translate("de", key)).not.toBe("Unbekannt");
    }
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
