import { describe, expect, test } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import {
  isModelWork,
  roundUsd,
  runNoticeDue,
  spendAllows,
  spendAttention,
  spendChoiceDue,
  spendCountable,
  spendCurrency,
  spendLimit,
  spendMonthWindow,
  spendStatus,
} from "./spend-budget.ts";

const at = (iso: string) => new Date(iso);

describe("spendMonthWindow", () => {
  test("a Berlin evening on the last UTC day of October already belongs to November", () => {
    const window = spendMonthWindow(at("2026-10-31T23:30:00Z"), "Europe/Berlin");
    expect(window.month).toBe("2026-11");
    expect(window.from.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-11-30T23:00:00.000Z");
  });

  test("the same instant is still October in UTC", () => {
    const window = spendMonthWindow(at("2026-10-31T23:30:00Z"), "UTC");
    expect(window.month).toBe("2026-10");
    expect(window.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  test("a month with a clock change starts and ends at local midnight", () => {
    const window = spendMonthWindow(at("2026-03-15T12:00:00Z"), "Europe/Berlin");
    expect(window.month).toBe("2026-03");
    expect(window.from.toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-03-31T22:00:00.000Z");
  });

  test("December rolls over into the next year", () => {
    const window = spendMonthWindow(at("2026-12-20T10:00:00Z"), "America/New_York");
    expect(window.month).toBe("2026-12");
    expect(window.to.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  test("an unknown time zone falls back to UTC", () => {
    expect(spendMonthWindow(new Date(FROZEN_NOW), "Nowhere/City").month).toBe("2023-11");
  });
});

describe("spendLimit and spendCountable", () => {
  test("the default is 50 dollars and 0 means no limit", () => {
    expect(spendLimit(undefined)).toBe(50);
    expect(spendLimit(20)).toBe(20);
    expect(spendLimit(0)).toBeNull();
  });

  test("only a USD price basis counts towards the dollar budget", () => {
    expect(spendCurrency(undefined, "USD")).toBe("USD");
    expect(spendCurrency(" usd ", "USD")).toBe("USD");
    expect(spendCountable(spendCurrency("usd", "USD"), "USD")).toBe(true);
    expect(spendCountable(spendCurrency("EUR", "USD"), "USD")).toBe(false);
  });
});

describe("spendStatus", () => {
  const facts = { limit_usd: 50, month: "2026-11", continue_month: "" };

  test("below 80 % is ok", () => {
    expect(spendStatus({ ...facts, spent_usd: 39.99 }).state).toBe("ok");
  });

  test("80 % warns without blocking", () => {
    const status = spendStatus({ ...facts, spent_usd: 40 });
    expect(status.state).toBe("warning");
    expect(status.blocks_model_work).toBe(false);
    expect(status.share).toBe(0.8);
  });

  test("100 % blocks model work", () => {
    const status = spendStatus({ ...facts, spent_usd: 50 });
    expect(status.state).toBe("reached");
    expect(status.blocks_model_work).toBe(true);
  });

  test("continuing this month lifts the block, last month's choice does not", () => {
    expect(spendStatus({ ...facts, spent_usd: 80, continue_month: "2026-11" })).toMatchObject({
      state: "continued",
      continued: true,
      blocks_model_work: false,
    });
    expect(spendStatus({ ...facts, spent_usd: 80, continue_month: "2026-10" }).state).toBe(
      "reached",
    );
  });

  test("without a limit nothing blocks", () => {
    expect(spendStatus({ ...facts, limit_usd: null, spent_usd: 900 })).toMatchObject({
      state: "unlimited",
      share: null,
      blocks_model_work: false,
    });
  });
});

describe("model work", () => {
  test("every model flow and turn helper is model work", () => {
    expect(isModelWork({ kind: "flow", flow: "converse" })).toBe(true);
    expect(isModelWork({ kind: "turn_helper", helper: "suggest_next" })).toBe(true);
  });

  test("a workflow step is model work only when it calls a model provider", () => {
    expect(isModelWork({ kind: "workflow_step", calls_model_provider: true })).toBe(true);
    expect(isModelWork({ kind: "workflow_step", calls_model_provider: false })).toBe(false);
  });

  test("a reached budget refuses model work and lets other steps run", () => {
    const reached = { blocks_model_work: true };
    expect(spendAllows(reached, { kind: "flow", flow: "generate" })).toBe(false);
    expect(spendAllows(reached, { kind: "workflow_step", calls_model_provider: false })).toBe(true);
    expect(spendAllows({ blocks_model_work: false }, { kind: "flow", flow: "generate" })).toBe(
      true,
    );
  });
});

describe("spendAttention", () => {
  const base = { limit_usd: 50, month: "2026-11", continue_month: "" };

  test("one warning item per month and one stop item per month", () => {
    expect(spendAttention(spendStatus({ ...base, spent_usd: 45 }))).toEqual({
      kind: "warning",
      id: "spend-warning:2026-11",
    });
    expect(spendAttention(spendStatus({ ...base, spent_usd: 55 }))).toEqual({
      kind: "reached",
      id: "spend-limit:2026-11",
    });
  });

  test("after continuing nothing asks again this month, and nothing shows below 80 %", () => {
    expect(
      spendAttention(spendStatus({ ...base, spent_usd: 55, continue_month: "2026-11" })),
    ).toBeNull();
    expect(spendAttention(spendStatus({ ...base, spent_usd: 10 }))).toBeNull();
  });
});

describe("spendChoiceDue", () => {
  test("a workspace that never chose a limit is asked once, a chosen one never", () => {
    expect(spendChoiceDue(false)).toEqual({ id: "spend-limit-unset" });
    expect(spendChoiceDue(true)).toBeNull();
  });
});

describe("runNoticeDue", () => {
  test("a chat turn that costs more than 5 dollars gets one notice", () => {
    expect(runNoticeDue({ run: "chat_turn", before_usd: 12, after_usd: 17.3 })).toEqual({
      run_cost_usd: 5.3,
      threshold_usd: 5,
    });
    expect(runNoticeDue({ run: "chat_turn", before_usd: 12, after_usd: 16.9 })).toBeNull();
    expect(runNoticeDue({ run: "chat_turn", before_usd: 0, after_usd: 5 })).toBeNull();
  });

  test("a task run gets the notice only on the turn that crosses 5 dollars", () => {
    expect(runNoticeDue({ run: "task_run", before_usd: 3, after_usd: 6 })).toEqual({
      run_cost_usd: 6,
      threshold_usd: 5,
    });
    expect(runNoticeDue({ run: "task_run", before_usd: 6, after_usd: 9 })).toBeNull();
    expect(runNoticeDue({ run: "task_run", before_usd: 1, after_usd: 4 })).toBeNull();
    expect(runNoticeDue({ run: "task_run", before_usd: 5, after_usd: 5.5 })?.run_cost_usd).toBe(
      5.5,
    );
  });
});

describe("roundUsd", () => {
  test("keeps four decimals so small model costs still add up", () => {
    expect(roundUsd(0.123456)).toBe(0.1235);
    expect(roundUsd(0.00004)).toBe(0);
    expect(roundUsd(12)).toBe(12);
  });
});
