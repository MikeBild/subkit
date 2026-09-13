import { expect, test } from "bun:test";

import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { suggestAuthorityBounds } from "../authority-suggestions.ts";

test("manual work keeps the finite one-run default", () => {
  const now = new Date(FROZEN_NOW);
  const bounds = suggestAuthorityBounds(now, []);
  expect(bounds.max_runs).toBe(1);
  expect(Date.parse(bounds.valid_until) - now.getTime()).toBe(86_400_000);
});

test("scheduled work suggests a month of occurrences, bounded by the existing ceiling", () => {
  const now = new Date(FROZEN_NOW);
  expect(suggestAuthorityBounds(now, [{ cron: "0 * * * *", timezone: "UTC" }]).max_runs).toBe(720);
  expect(suggestAuthorityBounds(now, [{ cron: "every:1", timezone: "UTC" }]).max_runs).toBe(10_000);
  expect(suggestAuthorityBounds(now, [{ cron: "invalid", timezone: "UTC" }]).max_runs).toBe(1);
});
