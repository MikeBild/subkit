import { describe, expect, test } from "bun:test";
import { axisPaddingLeft } from "@/pages/usage-chart";

const money = (amount: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD" }).format(amount);

describe("usage chart axis", () => {
  test("small labels keep the standard gutter", () => {
    expect(axisPaddingLeft(["0", "5", "10"])).toBe(44);
  });

  test("the widest tick label fits left of the axis, also for large amounts", () => {
    for (const top of [100, 1_000, 25_000, 1_000_000]) {
      const labels = [0, top / 2, top].map(money);
      const padding = axisPaddingLeft(labels);
      const widest = Math.max(...labels.map((label) => label.length));
      expect(padding - 6).toBeGreaterThanOrEqual(widest * 0.62 * 10);
    }
    expect(axisPaddingLeft([money(100)])).toBeGreaterThan(44);
  });
});
