import { describe, expect, it } from "bun:test";
import {
  AREA_OF,
  axisNumber,
  lastDays,
  usageSearch,
  usageTab,
  usageView,
} from "@/features/usage/model/usage";

describe("chart axis", () => {
  it("speaks the reader's number format and stays short", () => {
    expect(axisNumber("de-DE")(0.9)).toBe("0,9");
    expect(axisNumber("en-US")(0.9)).toBe("0.9");
    expect(axisNumber("de-DE")(1_200_000)).toBe("1,2 Mio.");
    expect(axisNumber("en-US")(1_200_000)).toBe("1.2M");
  });
});

const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}T00:00:00`;

function envelope(groups: { flow: string; buckets: { ts: string; cost: number }[] }[]) {
  return {
    bucket: "day",
    groups: groups.map((g) => ({
      key: { flow: g.flow },
      buckets: g.buckets.map((b) => ({
        ts: b.ts,
        calls: { total: 1 },
        tokens: { total: 10, prompt: 5, completion: 5 },
        cost: { amount: b.cost },
      })),
      totals: { calls: { total: 1 }, tokens: { total: 10 } },
      cost: { amount: g.buckets.reduce((s, b) => s + b.cost, 0) },
    })),
    totals: { calls: { total: 1 }, tokens: { total: 10 } },
    cost: { amount: 1, currency: "EUR" },
  };
}

describe("usage", () => {
  it("lastDays starts 29 days before today at local midnight", () => {
    const { from } = lastDays(new Date(2026, 10, 21, 15, 0));
    expect(new Date(from).getDate()).toBe(23);
    expect(new Date(from).getMonth()).toBe(9);
  });
  it("every engine flow maps to one of the three areas", () => {
    expect(AREA_OF.workflowRuns).toBe("workflow");
    expect(AREA_OF.chat).toBe("chat");
    expect(AREA_OF.authoring).toBe("other");
  });
  it("splits cost per day into workflow, chat and other and sums the window", () => {
    const span = {
      from: new Date(2026, 10, 1).toISOString(),
      to: new Date(2026, 10, 3).toISOString(),
    };
    const v = usageView(
      envelope([
        { flow: "workflow_step", buckets: [{ ts: day(1), cost: 2 }] },
        {
          flow: "converse",
          buckets: [
            { ts: day(1), cost: 1 },
            { ts: day(2), cost: 3 },
          ],
        },
        { flow: "judge", buckets: [{ ts: day(2), cost: 1 }] },
      ]),
      span,
    );
    expect(v.days).toHaveLength(2);
    expect(v.days[0]).toMatchObject({ cost: 3, workflow: 2, chat: 1, other: 0 });
    expect(v.days[1]).toMatchObject({ cost: 4, workflow: 0, chat: 3, other: 1 });
    expect(v.total).toBe(7);
    expect(v.avg).toBe(3.5);
  });
  it("deep links with a window, breakdown or sheet open the breakdown tab", () => {
    expect(usageTab("?view=details")).toBe("breakdown");
    expect(usageTab("?tab=breakdown")).toBe("breakdown");
    expect(usageTab("?window=lastWeek")).toBe("breakdown");
    expect(usageTab("?workflow=w1")).toBe("breakdown");
    expect(usageTab("?by=model&failed=1")).toBe("breakdown");
    expect(usageTab("")).toBe("overview");
    expect(usageTab("?foo=1")).toBe("overview");
    expect(usageTab("?tab=overview&window=lastWeek")).toBe("overview");
  });
  it("the old details address becomes the breakdown tab and keeps its state", () => {
    expect(usageSearch("?view=details", "breakdown")).toBe("?tab=breakdown");
    expect(usageSearch("?window=lastMonth&workflow=w1", "breakdown")).toBe(
      "?window=lastMonth&workflow=w1&tab=breakdown",
    );
    expect(usageSearch("?tab=breakdown&window=lastMonth&by=model&q=x", "overview")).toBe("?q=x");
  });
});
