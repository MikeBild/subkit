// Unit tests for the SettingsModal `pickInitialOuter` helper.

import { describe, expect, test } from "bun:test";

import { ALL_TABS, pickInitialOuter } from "../SettingsModal.tsx";

describe("pickInitialOuter", () => {
  test("undefined initialTab → 0 (Status)", () => {
    expect(pickInitialOuter(undefined, ALL_TABS)).toBe(0);
  });

  test("exact-match (case-sensitive same)", () => {
    expect(pickInitialOuter("Config", ALL_TABS)).toBe(1);
    expect(pickInitialOuter("Usage", ALL_TABS)).toBe(2);
    expect(pickInitialOuter("Skills", ALL_TABS)).toBe(3);
    expect(pickInitialOuter("Knowledge", ALL_TABS)).toBe(4);
  });

  test("case-insensitive match", () => {
    expect(pickInitialOuter("config", ALL_TABS)).toBe(1);
    expect(pickInitialOuter("CONFIG", ALL_TABS)).toBe(1);
    expect(pickInitialOuter("CoNfIg", ALL_TABS)).toBe(1);
  });

  test("unknown / removed tab names fall back to 0 (Status)", () => {
    // Tabs that used to exist:
    expect(pickInitialOuter("Settings", ALL_TABS)).toBe(0);
    expect(pickInitialOuter("Stats", ALL_TABS)).toBe(0);
    expect(pickInitialOuter("Permissions", ALL_TABS)).toBe(0);
    expect(pickInitialOuter("Profile", ALL_TABS)).toBe(0);
    expect(pickInitialOuter("Admin", ALL_TABS)).toBe(0);
  });

  test("legacy engine-section names (e.g. 'llm') fall back to 0", () => {
    for (const legacy of ["llm", "server", "database", "auth", "log"]) {
      expect(pickInitialOuter(legacy, ALL_TABS)).toBe(0);
    }
  });

  test("empty string falls back to 0", () => {
    expect(pickInitialOuter("", ALL_TABS)).toBe(0);
  });

  test("garbage input doesn't throw", () => {
    expect(() => pickInitialOuter("not-a-tab-name", ALL_TABS)).not.toThrow();
    expect(pickInitialOuter("not-a-tab-name", ALL_TABS)).toBe(0);
  });
});
