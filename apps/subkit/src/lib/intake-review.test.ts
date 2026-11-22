import { describe, expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";
import { cliLocale, intakeReviewPrompt, SELECTED_ITEMS_LABEL } from "./intake-review.ts";

describe("the language of an intake review", () => {
  test("German settings choose German and anything else English", () => {
    expect(cliLocale({ LANG: "de_DE.UTF-8" })).toBe("de");
    expect(cliLocale({ LC_ALL: "de_AT.UTF-8", LANG: "en_US.UTF-8" })).toBe("de");
    expect(cliLocale({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(cliLocale({ LANG: "fr_FR.UTF-8" })).toBe("en");
    expect(cliLocale({})).toBe("en");
  });

  test("an explicit flag wins over SUBKIT_LANG and the shell", () => {
    expect(cliLocale({ SUBKIT_LANG: "en", LANG: "de_DE.UTF-8" }, "de")).toBe("de");
    expect(cliLocale({ SUBKIT_LANG: "de", LANG: "en_US.UTF-8" })).toBe("de");
    expect(cliLocale({ LANG: "de_DE.UTF-8" }, "en")).toBe("en");
  });

  test("the neutral C and POSIX locales do not hide a later German setting", () => {
    expect(cliLocale({ LC_ALL: "C", LANG: "de_DE.UTF-8" })).toBe("de");
    expect(cliLocale({ LC_ALL: "POSIX", LANG: "en_US.UTF-8" })).toBe("en");
  });

  test("the prompt stays English by default and has a German twin", () => {
    expect(intakeReviewPrompt("inbox")).toContain("Review my new items in “inbox”.");
    expect(intakeReviewPrompt("inbox", "de")).toContain(
      "Schau meine neuen Einträge in „inbox“ durch.",
    );
    expect(intakeReviewPrompt(SELECTED_ITEMS_LABEL, "de")).toContain(
      "Schau die ausgewählten Einträge durch.",
    );
  });

  test("control sequences in a category never reach the German prompt", () => {
    expect(intakeReviewPrompt("In\u001b[31mbox\u0007", "de")).not.toContain("\u001b");
  });
});

describe("the engine client language header", () => {
  const client = (language?: "de" | "en") =>
    new EngineClient({ engine_url: "https://engine.test", api_key: "key", language });

  test("sends the chosen language", () => {
    expect(client("de").headers()["accept-language"]).toBe("de");
  });

  test("sends no language header when none is chosen", () => {
    expect(client().headers()["accept-language"]).toBeUndefined();
  });
});
