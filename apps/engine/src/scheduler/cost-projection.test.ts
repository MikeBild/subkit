import { describe, expect, test } from "bun:test";
import { projectScheduleCost, runsPerMonth } from "./cost-projection.ts";

const AT = new Date("2026-11-23T10:00:00.000Z");

describe("runsPerMonth", () => {
  test("a daily cron runs about 30.4 times a month", () => {
    expect(runsPerMonth({ cron: "0 8 * * *", timezone: "Europe/Berlin" }, AT)).toBe(30.42);
  });

  test("a weekly cron runs about 4.3 times a month", () => {
    expect(runsPerMonth({ cron: "0 8 * * 1", timezone: "UTC" }, AT)).toBe(4.33);
  });

  test("a monthly cron runs once a month whatever the day of the month", () => {
    expect(runsPerMonth({ cron: "0 8 1 * *", timezone: "UTC" }, AT)).toBe(1);
    expect(
      runsPerMonth({ cron: "0 8 1 * *", timezone: "UTC" }, new Date("2026-11-30T23:00:00Z")),
    ).toBe(1);
  });

  test("an every-minute cron extrapolates past the occurrence cap", () => {
    expect(runsPerMonth({ cron: "* * * * *", timezone: "UTC" }, AT)).toBe(43800);
  });

  test("an interval counts the seconds of an average month", () => {
    expect(runsPerMonth({ cron: "every:3600", timezone: "UTC" }, AT)).toBe(730);
  });

  test("business days only leaves out weekends", () => {
    const runs = runsPerMonth(
      { cron: "0 8 * * *", timezone: "UTC", input: { business_days_only: true } },
      AT,
    );
    expect(runs).toBe(21.75);
  });

  test("an invalid rhythm cannot be counted", () => {
    expect(runsPerMonth({ cron: "not a cron", timezone: "UTC" }, AT)).toBeNull();
    expect(runsPerMonth({ cron: "every:0", timezone: "UTC" }, AT)).toBeNull();
  });
});

describe("projectScheduleCost", () => {
  test("multiplies the average cost per run of the version by runs a month", () => {
    const projection = projectScheduleCost({
      runs_per_month: 30,
      version: { runs: 12, amount: 1.68, unpriced_models: [] },
      workflow: null,
      currency: "EUR",
    });
    expect(projection).toEqual({
      state: "estimated",
      basis: "version",
      runs_sampled: 12,
      runs_per_month: 30,
      per_run_amount: 0.14,
      monthly_amount: 4.2,
      currency: "EUR",
      unpriced_models: [],
      rates_basis: "current",
    });
  });

  test("falls back to other versions of the workflow when the version has no run", () => {
    const projection = projectScheduleCost({
      runs_per_month: 4,
      version: null,
      workflow: { runs: 3, amount: 0.3, unpriced_models: ["z-model", "a-model"] },
      currency: "USD",
    });
    expect(projection.state).toBe("estimated");
    expect(projection.basis).toBe("workflow");
    expect(projection.runs_sampled).toBe(3);
    expect(projection.monthly_amount).toBe(0.4);
    expect(projection.unpriced_models).toEqual(["a-model", "z-model"]);
  });

  test("runs without model calls count, so a workflow without them costs nothing", () => {
    const projection = projectScheduleCost({
      runs_per_month: 30,
      version: { runs: 5, amount: 0, unpriced_models: [] },
      workflow: null,
      currency: "USD",
    });
    expect(projection.state).toBe("estimated");
    expect(projection.monthly_amount).toBe(0);
  });

  test("reports no estimate yet without any finished run", () => {
    const projection = projectScheduleCost({
      runs_per_month: 30,
      version: null,
      workflow: null,
      currency: "USD",
    });
    expect(projection).toEqual({
      state: "no_history",
      basis: null,
      runs_sampled: 0,
      runs_per_month: 30,
      per_run_amount: null,
      monthly_amount: null,
      currency: "USD",
      unpriced_models: [],
      rates_basis: "current",
    });
  });

  test("an uncountable rhythm keeps the cost per run but no monthly amount", () => {
    const projection = projectScheduleCost({
      runs_per_month: null,
      version: { runs: 2, amount: 1, unpriced_models: [] },
      workflow: null,
      currency: "USD",
    });
    expect(projection.state).toBe("unknown_rhythm");
    expect(projection.per_run_amount).toBe(0.5);
    expect(projection.monthly_amount).toBeNull();
  });
});
