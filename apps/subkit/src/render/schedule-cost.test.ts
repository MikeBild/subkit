import { describe, expect, test } from "bun:test";
import { formatScheduleCost } from "./schedule-cost.ts";

const estimated = {
  state: "estimated" as const,
  basis: "version" as const,
  runs_sampled: 12,
  runs_per_month: 30.42,
  per_run_amount: 0.138,
  monthly_amount: 4.2,
  currency: "EUR",
  unpriced_models: [],
  rates_basis: "current" as const,
};

describe("formatScheduleCost", () => {
  test("names the monthly amount and the runs it is based on", () => {
    expect(formatScheduleCost(estimated)).toBe("≈ €4.20/month (12 runs)");
  });

  test("names earlier versions when the current version has not run yet", () => {
    expect(
      formatScheduleCost({ ...estimated, basis: "workflow", runs_sampled: 1, currency: "USD" }),
    ).toBe("≈ $4.20/month (1 run, earlier versions)");
  });

  test("says when unpriced models are left out", () => {
    expect(formatScheduleCost({ ...estimated, unpriced_models: ["local-model"] })).toBe(
      "≈ €4.20/month (12 runs, unpriced models left out)",
    );
  });

  test("says there is no estimate yet without finished runs", () => {
    expect(
      formatScheduleCost({
        ...estimated,
        state: "no_history",
        basis: null,
        runs_sampled: 0,
        per_run_amount: null,
        monthly_amount: null,
      }),
    ).toBe("no estimate yet");
  });
});
