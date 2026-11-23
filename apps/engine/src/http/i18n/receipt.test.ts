import { describe, expect, test } from "bun:test";
import { RECEIPT_COPY, receiptLine } from "./receipt.ts";

describe("a receipt quotes the person's own words", () => {
  test("in both languages, with the quote in place", () => {
    expect(receiptLine("receipt.you_said", "send it to Jane")).toBe("You said: “send it to Jane”");
    expect(receiptLine("receipt.your_rule", "always send it", "de")).toBe(
      RECEIPT_COPY.de["receipt.your_rule"].replace("{quote}", "always send it"),
    );
  });

  test("the words are placed as they are, also when they look like a pattern", () => {
    expect(receiptLine("receipt.you_said", "pay $& now")).toBe("You said: “pay $& now”");
  });

  test("every key has copy with one place for the quote in each language", () => {
    for (const locale of ["en", "de"] as const)
      for (const copy of Object.values(RECEIPT_COPY[locale])) {
        expect(copy.split("{quote}")).toHaveLength(2);
        expect(copy).not.toContain("!");
      }
  });
});
