import { describe, expect, test } from "bun:test";
import {
  decimalSeparatorFor,
  moneyText,
  normalizeDecimal,
  parseAmount,
  parseTokens,
} from "@/features/settings/model/settings-units";

describe("amounts and token counts", () => {
  test("parse amounts and token counts typed by people", () => {
    expect(parseTokens("1.000.000")).toBe(1_000_000);
    expect(parseTokens("abc")).toBeNull();
    expect(parseAmount("0,40")).toBe(0.4);
    expect(parseAmount("x")).toBeNull();
  });

  test("format money in the reader's language", () => {
    expect(moneyText(0.4, "USD", "de").replace(/\s/g, " ")).toBe("0,40 $");
    expect(moneyText(0.4, "USD", "en")).toBe("$0.40");
  });
});

describe("amounts typed with thousands separators", () => {
  test("read in German and English notation alike", () => {
    expect(normalizeDecimal("1.000,50")).toBe("1000.50");
    expect(normalizeDecimal("1,000.50")).toBe("1000.50");
    expect(normalizeDecimal("1 000,50")).toBe("1000.50");
    expect(normalizeDecimal("1.000.000")).toBe("1000000");
    expect(normalizeDecimal("0,500")).toBe("0.500");
    expect(normalizeDecimal("1.2.3")).toBeNull();
    expect(parseAmount("1.000,50")).toBe(1000.5);
  });
});

describe("amounts in the reader's locale (#508)", () => {
  test("English reads a single dot with three digits as a decimal fraction", () => {
    expect(parseAmount("1234.567", decimalSeparatorFor("en"))).toBe(1234.567);
    expect(parseAmount("0.125", decimalSeparatorFor("en"))).toBe(0.125);
    expect(parseAmount("1,234", decimalSeparatorFor("en"))).toBe(1234);
    expect(parseAmount("1,000.50", decimalSeparatorFor("en"))).toBe(1000.5);
  });

  test("German reads a single comma with three digits as a decimal fraction", () => {
    expect(parseAmount("1234,567", decimalSeparatorFor("de"))).toBe(1234.567);
    expect(parseAmount("1.234", decimalSeparatorFor("de"))).toBe(1234);
    expect(parseAmount("1.000,50", decimalSeparatorFor("de"))).toBe(1000.5);
  });
});
