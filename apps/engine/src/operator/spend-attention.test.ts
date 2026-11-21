import { describe, expect, test } from "bun:test";
import { spendStatus } from "../llm/core/spend-budget.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { spendCandidates } from "./spend-attention.ts";

function reading(spent: number, chosen = true) {
  const at = new Date(FROZEN_NOW);
  return {
    ...spendStatus({ limit_usd: 50, spent_usd: spent, month: "2023-11", continue_month: "" }),
    currency: "USD" as const,
    countable: true,
    timezone: "UTC",
    window: { month: "2023-11", from: at, to: at },
    unpriced_calls: 0,
    chosen,
  };
}

describe("spend attention", () => {
  test("at the limit an admin gets raise and continue in Settings › Usage", () => {
    const [candidate] = spendCandidates(reading(50));
    expect(candidate?.item).toMatchObject({ id: "spend-limit:2023-11", class: "stopped" });
    expect(candidate?.item.actions.map((action) => action.href)).toEqual([
      "/cockpit/settings?area=usage&spend=raise",
      "/cockpit/settings?area=usage&spend=continue",
    ]);
    expect(candidate?.item.actions.every((a) => a.permission === "identity:write")).toBe(true);
  });

  test("a workspace from before the budget is asked once to set a monthly limit", () => {
    expect(spendCandidates(reading(0, false)).map((c) => c.item.reason)).toEqual([
      "spend_limit_unset",
    ]);
    expect(spendCandidates(reading(0, true))).toEqual([]);
  });

  test("80 % is one notice to decide, below that nothing", () => {
    expect(spendCandidates(reading(40))[0]?.item).toMatchObject({
      id: "spend-warning:2023-11",
      class: "decide",
      reason: "spend_warning",
    });
    expect(spendCandidates(reading(10))).toEqual([]);
  });
});
