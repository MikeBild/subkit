import { describe, expect, test } from "bun:test";
import { ftsConfigFor } from "./fts-config.ts";

describe("ftsConfigFor", () => {
  test("a German workspace searches with the German dictionary", () => {
    expect(ftsConfigFor("de")).toBe("german");
  });

  test("every other workspace language falls back to English", () => {
    expect(ftsConfigFor("en")).toBe("english");
    expect(ftsConfigFor(null)).toBe("english");
    expect(ftsConfigFor(undefined)).toBe("english");
    expect(ftsConfigFor("fr")).toBe("english");
  });
});
