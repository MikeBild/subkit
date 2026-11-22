import { describe, expect, test } from "bun:test";
import { conversationLocale, requestLanguage } from "./locale.ts";

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

  test("a request without a known language says so instead of guessing", () => {
    expect(requestLanguage(undefined, undefined)).toBeNull();
    expect(requestLanguage("sk_locale=fr", "fr-FR")).toBeNull();
    expect(requestLanguage(undefined, "en;q=0, de;q=0")).toBeNull();
    expect(requestLanguage("sk_locale=de", undefined)).toBe("de");
    expect(requestLanguage(undefined, "en-GB")).toBe("en");
  });
});
