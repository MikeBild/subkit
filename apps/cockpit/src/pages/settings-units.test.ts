import { describe, expect, test } from "bun:test";
import {
  BUDGET_PRESETS,
  budgetPresetOf,
  budgetPresetTokens,
  dollarsToMicrounits,
  microunitsToDollars,
  moneyText,
  parseAmount,
  parseTokens,
} from "@/pages/settings-units";

describe("dollar amounts as microunits", () => {
  test("convert with string math only", () => {
    expect(dollarsToMicrounits("12.5")).toBe("12500000");
    expect(dollarsToMicrounits("12,5")).toBe("12500000");
    expect(dollarsToMicrounits("0.000001")).toBe("1");
    expect(dollarsToMicrounits("999999999999")).toBe("999999999999000000");
  });

  test("reject more precision than a microunit, zero and oversized values", () => {
    expect(dollarsToMicrounits("0.0000001")).toBeNull();
    expect(dollarsToMicrounits("0")).toBeNull();
    expect(dollarsToMicrounits("0.000000")).toBeNull();
    expect(dollarsToMicrounits("1000000000000")).toBeNull();
    expect(dollarsToMicrounits("-1")).toBeNull();
    expect(dollarsToMicrounits("1e3")).toBeNull();
  });

  test("round-trip back to dollars", () => {
    for (const dollars of ["12.5", "1", "0.000001", "250", "999999999999"]) {
      const micro = dollarsToMicrounits(dollars);
      expect(micro).not.toBeNull();
      expect(microunitsToDollars(micro ?? "")).toBe(dollars);
    }
    expect(microunitsToDollars("0")).toBe("0");
    expect(microunitsToDollars("01")).toBeNull();
  });
});

describe("monthly budget presets", () => {
  test("map to their token counts and back", () => {
    expect(BUDGET_PRESETS.map((preset) => preset.tokens)).toEqual([0, 1e6, 1e7, 1e8]);
    expect(budgetPresetOf(0)).toBe("none");
    expect(budgetPresetOf(10_000_000)).toBe("10m");
    expect(budgetPresetOf(123)).toBe("custom");
    expect(budgetPresetTokens("100m")).toBe(100_000_000);
    expect(budgetPresetTokens("custom")).toBeNull();
  });

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
