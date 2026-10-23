import { describe, expect, test } from "bun:test";
import { axisPaddingLeft, chartLayout } from "@/pages/usage-chart";

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

describe("usage chart layout", () => {
  test("a phone draws the chart at its own width so the text stays readable", () => {
    const layout = chartLayout(327, 7, 44);
    expect(layout.width).toBe(327);
    expect(layout.labelEvery).toBeGreaterThan(1);
    expect(layout.showTotals).toBe(false);
  });

  test("many buckets scroll instead of shrinking below a readable slot", () => {
    expect(chartLayout(327, 24, 44).width).toBe(720);
    expect(chartLayout(1100, 31, 44).width).toBe(1100);
  });

  test("a wide screen labels every day and shows the totals", () => {
    const layout = chartLayout(900, 7, 44);
    expect(layout.labelEvery).toBe(1);
    expect(layout.showTotals).toBe(true);
  });

  test("before the first measurement the chart keeps its desktop width", () => {
    expect(chartLayout(0, 7, 44).width).toBe(1000);
  });
});
