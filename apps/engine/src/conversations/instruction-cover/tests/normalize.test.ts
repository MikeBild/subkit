import { describe, expect, test } from "bun:test";
import { checkQuote, normalizeForQuote } from "@shared/quote-text.ts";

describe("quote normalisation", () => {
  test("case, whitespace, quote marks, dashes and diacritics do not matter", () => {
    expect(normalizeForQuote("  Schick  „Grüße“ –\n heute ")).toBe(
      'schick "gruße" - heute'.replace("ß", "ss"),
    );
    expect(checkQuote("schick 'grusse' - HEUTE", "Bitte schick „Grüße“ – heute an alle").ok).toBe(
      true,
    );
  });

  test("addresses, links and identifiers are compared exactly", () => {
    const text = "Send INV-2024-17 to Anna@Firma.de via https://Example.com/Path?x=1.";
    expect(checkQuote("send INV-2024-17 to Anna@Firma.de", text).ok).toBe(true);
    expect(checkQuote("send inv-2024-17 to Anna@Firma.de", text).ok).toBe(false);
    expect(checkQuote("send INV-2024-17 to anna@firma.de", text).ok).toBe(false);
    expect(checkQuote("to Anna@Firma.de via https://example.com/path?x=1", text).ok).toBe(false);
    expect(checkQuote("to Anna@Firma.de via https://Example.com/Path?x=1", text).ok).toBe(true);
  });

  test("a quote has to stand on word boundaries and be long enough", () => {
    expect(checkQuote("end it now", "Send it now")).toEqual({
      ok: false,
      reason: "quote_not_in_user_words",
    });
    expect(checkQuote("send", "Send it now")).toEqual({ ok: false, reason: "quote_too_short" });
    expect(checkQuote("x ".repeat(300), "Send it now")).toEqual({
      ok: false,
      reason: "quote_too_long",
    });
  });

  test("words the person never wrote are not found", () => {
    expect(checkQuote("send it to everyone", "Please send it to Bob")).toEqual({
      ok: false,
      reason: "quote_not_in_user_words",
    });
  });
});
