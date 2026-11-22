import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKSPACE_LANGUAGE,
  firstLanguage,
  isWorkspaceLanguage,
  languageOf,
  WORKSPACE_LANGUAGES,
} from "./workspace-language.ts";

describe("the workspace language", () => {
  test("is German or English and English by default", () => {
    expect(WORKSPACE_LANGUAGES).toEqual(["de", "en"]);
    expect(DEFAULT_WORKSPACE_LANGUAGE).toBe("en");
    expect(isWorkspaceLanguage("de")).toBe(true);
    expect(isWorkspaceLanguage("en")).toBe(true);
    expect(isWorkspaceLanguage("fr")).toBe(false);
    expect(isWorkspaceLanguage(null)).toBe(false);
  });

  test("a language tag or header resolves to its primary language", () => {
    expect(languageOf("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(languageOf("EN-us")).toBe("en");
    expect(languageOf("deutsch")).toBeNull();
    expect(languageOf("fr")).toBeNull();
    expect(languageOf(7)).toBeNull();
    expect(languageOf(undefined)).toBeNull();
  });

  test("the first supported preference wins and nothing supported falls back to English", () => {
    expect(firstLanguage(["de", "en"])).toBe("de");
    expect(firstLanguage([null, "en"])).toBe("en");
    expect(firstLanguage(["fr", undefined, 7, "de-AT"])).toBe("de");
    expect(firstLanguage(["deutsch", "english"])).toBe("en");
    expect(firstLanguage([])).toBe("en");
  });
});
