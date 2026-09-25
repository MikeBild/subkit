// This CLI talks to engines it did not ship with.
//
// The digest gained `scheduled_count` so a failing schedule that somebody
// retried by hand keeps counting as an operational failure. The cockpit is
// embedded in the engine binary and always matches it; `sk` is not — a current
// CLI against an older engine gets a payload without the field. Reading it
// directly makes `undefined > 0` false, and every failing production schedule
// renders as a harmless trial run: a downgrade of exactly the signal this
// panel exists to give.

import { expect, test } from "bun:test";
import { type DigestFailureGroup, resolvedAtOf, scheduledRunsOf } from "./self-healing.ts";

const group = (over: Partial<DigestFailureGroup>): DigestFailureGroup => ({
  signature: "sig",
  workflow_id: "wf",
  workflow_name: "Hourly Sync",
  step_key: "fetch",
  error_code: "http_4xx",
  origin: "scheduled",
  count: 9,
  scheduled_count: 9,
  last_seen: "2026-09-25T06:00:00.000Z",
  resolved_at: null,
  cause: "The address answered 404.",
  guidance: null,
  ...over,
});

test("an engine that reports the number is believed", () => {
  expect(scheduledRunsOf(group({ origin: "mixed", count: 9, scheduled_count: 8 }))).toBe(8);
  expect(scheduledRunsOf(group({ origin: "mixed", count: 9, scheduled_count: 0 }))).toBe(0);
});

test("an engine that does not report it is read through the old shape", () => {
  const old = (over: Partial<DigestFailureGroup>) => {
    const { scheduled_count: _omitted, ...rest } = group(over);
    return rest as DigestFailureGroup;
  };
  // The ordinary cases stay right: a scheduled group is still an incident, an
  // authoring trial still is not.
  expect(scheduledRunsOf(old({ origin: "scheduled", count: 9 }))).toBe(9);
  expect(scheduledRunsOf(old({ origin: "authoring", count: 9 }))).toBe(0);
  expect(scheduledRunsOf(old({ origin: "manual", count: 9 }))).toBe(0);
  // "mixed" is the case the field exists to fix, and an old engine cannot
  // answer it. Reading it as "not scheduled" reproduces the old behaviour
  // rather than inventing an answer the payload does not contain.
  expect(scheduledRunsOf(old({ origin: "mixed", count: 9 }))).toBe(0);
});

test("zero runs is not the same as an absent field", () => {
  // A group the engine counted at zero scheduled runs must stay zero, not fall
  // through to the origin guess — that is how a fallback quietly becomes the
  // rule again.
  expect(scheduledRunsOf(group({ origin: "scheduled", count: 4, scheduled_count: 0 }))).toBe(0);
});

test("an engine that cannot tell whether it recovered is not taken as an all-clear", () => {
  // The same mixed-version problem, and the opposite safe direction from
  // `scheduled_count`: there, a missing field must not hide a live failure by
  // reading as zero; here, a missing field must not CLOSE one by reading as
  // recovered. Both defaults keep the failure on screen, where a human decides.
  const { resolved_at: _omitted, ...withoutField } = group({});
  expect(resolvedAtOf(withoutField as DigestFailureGroup)).toBeNull();
  expect(resolvedAtOf(group({ resolved_at: null }))).toBeNull();
  expect(resolvedAtOf(group({ resolved_at: "2026-09-25T08:00:00.000Z" }))).toBe(
    "2026-09-25T08:00:00.000Z",
  );
});
