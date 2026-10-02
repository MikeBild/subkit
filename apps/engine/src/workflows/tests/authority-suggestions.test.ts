import { expect, test } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import {
  HOOK_MINIMUM_RUNS,
  HOOK_RUN_HEADROOM,
  suggestAuthorityBounds,
} from "../authority-suggestions.ts";

const THIRTY_DAYS_MS = 30 * 86_400_000;

test("manual work keeps the finite one-run default", () => {
  const now = new Date(FROZEN_NOW);
  const bounds = suggestAuthorityBounds(now, []);
  expect(bounds.max_runs).toBe(1);
  expect(Date.parse(bounds.valid_until) - now.getTime()).toBe(86_400_000);
  expect(bounds.basis).toEqual({ kind: "manual" });
});

test("scheduled work suggests a month of occurrences, bounded by the existing ceiling", () => {
  const now = new Date(FROZEN_NOW);
  expect(suggestAuthorityBounds(now, [{ cron: "0 * * * *", timezone: "UTC" }]).max_runs).toBe(720);
  expect(suggestAuthorityBounds(now, [{ cron: "every:1", timezone: "UTC" }]).max_runs).toBe(10_000);
  expect(suggestAuthorityBounds(now, [{ cron: "invalid", timezone: "UTC" }]).max_runs).toBe(1);
});

test("a schedule names itself as the basis of its suggestion", () => {
  const now = new Date(FROZEN_NOW);
  const bounds = suggestAuthorityBounds(now, [{ cron: "0 * * * *", timezone: "UTC" }]);
  expect(bounds.basis).toEqual({ kind: "schedule", scheduled_runs: 720 });
  expect(Date.parse(bounds.valid_until) - now.getTime()).toBe(THIRTY_DAYS_MS);
});

test("a hook-started workflow gets thirty days sized from its recent deliveries", () => {
  const now = new Date(FROZEN_NOW);
  // 140 deliveries in 14 days = 10 a day; thirty days of that, doubled.
  const bounds = suggestAuthorityBounds(now, [], { deliveries: 140, window_days: 14 });
  expect(Date.parse(bounds.valid_until) - now.getTime()).toBe(THIRTY_DAYS_MS);
  expect(bounds.max_runs).toBe(10 * 30 * HOOK_RUN_HEADROOM);
  expect(bounds.basis).toEqual({
    kind: "hook",
    scheduled_runs: 0,
    observed_deliveries: 140,
    observed_days: 14,
    minimum_applied: false,
  });
});

test("a hook that was barely called still gets the floor, and says so", () => {
  const now = new Date(FROZEN_NOW);
  for (const deliveries of [0, 3]) {
    const bounds = suggestAuthorityBounds(now, [], { deliveries, window_days: 14 });
    expect(bounds.max_runs).toBe(HOOK_MINIMUM_RUNS);
    expect(Date.parse(bounds.valid_until) - now.getTime()).toBe(THIRTY_DAYS_MS);
    expect(bounds.basis).toMatchObject({ kind: "hook", minimum_applied: true });
  }
  // A window that observed nothing cannot be projected; the floor stands.
  expect(suggestAuthorityBounds(now, [], { deliveries: 5, window_days: 0 }).max_runs).toBe(
    HOOK_MINIMUM_RUNS,
  );
});

test("a schedule and a hook add up, within the existing ceiling", () => {
  const now = new Date(FROZEN_NOW);
  const schedule = [{ cron: "0 * * * *", timezone: "UTC" }];
  const both = suggestAuthorityBounds(now, schedule, { deliveries: 140, window_days: 14 });
  expect(both.max_runs).toBe(720 + 600);
  expect(both.basis).toMatchObject({ kind: "hook", scheduled_runs: 720 });
  expect(
    suggestAuthorityBounds(now, schedule, { deliveries: 1_000_000, window_days: 14 }).max_runs,
  ).toBe(10_000);
});
