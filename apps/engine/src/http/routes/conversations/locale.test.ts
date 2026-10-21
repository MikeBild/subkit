import { describe, expect, test } from "bun:test";
import { conversationLocale } from "./locale.ts";

describe("conversation locale", () => {
  test("uses an explicit Cockpit preference before the browser language", () => {
    expect(conversationLocale("sk_locale=en", "de-DE,de;q=0.9")).toBe("en");
    expect(conversationLocale("sk_locale=de", "en-US,en;q=0.9")).toBe("de");
  });

  test("uses the browser language when the preference is automatic", () => {
    expect(conversationLocale("other=value", "en-US,en;q=0.9")).toBe("en");
    expect(conversationLocale(undefined, "de-DE,de;q=0.9")).toBe("de");
    expect(conversationLocale(undefined, "fr-CA, de-DE;q=0.9, en;q=0.8")).toBe("de");
    expect(conversationLocale(undefined, "en;q=0, de;q=1")).toBe("de");
    expect(conversationLocale(undefined, "de;q=0, en-US;q=0.7")).toBe("en");
    expect(conversationLocale(undefined, "en;q=0, de;q=0")).toBe("en");
    expect(conversationLocale(undefined, undefined)).toBe("en");
  });
});
