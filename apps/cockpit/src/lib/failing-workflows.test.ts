// What counts as "approved and failing", and what a link to it must lead to.

import { expect, test } from "bun:test";
import { type DigestFailureGroup, failingWorkflows } from "./failing-workflows";

const group = (over: Partial<DigestFailureGroup>): DigestFailureGroup => ({
  signature: "sig",
  workflow_id: "wf-1",
  workflow_name: "Product analytics hourly",
  step_key: "subkit_health",
  error_code: "http_4xx",
  origin: "scheduled",
  count: 76,
  scheduled_count: 76,
  last_seen: "2026-09-23T10:00:00.000Z",
  resolved_at: null,
  cause: "The address answered 404.",
  guidance: null,
  ...over,
});

test("a scheduled workflow that keeps failing is a decision", () => {
  // The production case: a live approval, the same step, 76 times, and nothing
  // in the cockpit said so.
  const [failing] = failingWorkflows([group({})]);
  expect(failing?.workflow_name).toBe("Product analytics hourly");
  expect(failing?.step_key).toBe("subkit_health");
  expect(failing?.count).toBe(76);
  expect(failing?.cause).toBe("The address answered 404.");
});

test("a cause the workflow has already recovered from is not a decision", () => {
  // The production case in the other direction: the grant was re-issued, the
  // schedule has run clean twice since, and the tile went on counting it — an
  // open decision with no action left that could close it.
  expect(failingWorkflows([group({ resolved_at: "2026-09-24T04:12:00.000Z" })])).toHaveLength(0);
  // And the guard against over-correcting: only a scheduled success resolves
  // it, so a group still carrying a live cause stays.
  expect(failingWorkflows([group({ resolved_at: null })])).toHaveLength(1);
  // An engine that does not report the field at all also keeps it. This is not
  // hypothetical pedantry: comparing `=== null` here read `undefined` as
  // resolved and silently emptied the list, and the convention check found it
  // as the nav badge and the page disagreeing by one.
  const { resolved_at: _absent, ...older } = group({});
  expect(failingWorkflows([older as DigestFailureGroup])).toHaveLength(1);
});

test("the link leads to those runs, not to every run", () => {
  // "Production incidents: 1" pointed at eleven thousand rows. A number that
  // names something has to lead to that something.
  const [failing] = failingWorkflows([group({})]);
  // Router-relative, and this test used to pin the absolute form — which is how
  // the broken link shipped. The router carries `/cockpit` as its base, so an
  // absolute href became `/cockpit/cockpit/runs` and the one way out of a
  // failing decision landed on "page not found". A test that agrees with the
  // defect is worse than no test: it certifies it.
  expect(failing?.runs_href).toBe("/runs?status=failed&q=Product%20analytics%20hourly");
  // Without a name there is nothing to search for, but the status still narrows.
  const [unnamed] = failingWorkflows([group({ workflow_name: null })]);
  expect(unnamed?.runs_href).toBe("/runs?status=failed");
});

test("an authoring trial that failed is feedback, not an incident", () => {
  // Mixing the two is how a real incident ends up buried among experiments.
  expect(failingWorkflows([group({ origin: "authoring", scheduled_count: 0 })])).toEqual([]);
  expect(failingWorkflows([group({ origin: "manual", scheduled_count: 0 })])).toEqual([]);
});

test("retrying it by hand does not delete the record that it broke", () => {
  // The production shape: an hourly workflow fails, an operator retries it once
  // from the CLI, the group turns "mixed" — and the decision used to vanish
  // from the queue while the schedule kept failing every hour.
  const [failing] = failingWorkflows([group({ origin: "mixed", count: 77, scheduled_count: 76 })]);
  expect(failing?.count).toBe(77);
  // A group that is mixed because someone tried it manually AND in the editor
  // never ran unattended, so it is still not an operational decision.
  expect(failingWorkflows([group({ origin: "mixed", scheduled_count: 0 })])).toEqual([]);
});

test("the worst comes first, and ties keep a stable order", () => {
  const rows = failingWorkflows([
    group({ signature: "b", count: 3, scheduled_count: 3 }),
    group({ signature: "a", count: 76, scheduled_count: 76 }),
    group({ signature: "c", count: 3, scheduled_count: 3 }),
  ]);
  expect(rows.map((row) => row.key)).toEqual(["a", "b", "c"]);
});

test("nothing to report is an empty list", () => {
  expect(failingWorkflows([])).toEqual([]);
  expect(failingWorkflows(null)).toEqual([]);
  expect(failingWorkflows(undefined)).toEqual([]);
  // A group the engine counted at zero is not a failure anyone can act on.
  expect(failingWorkflows([group({ count: 0, scheduled_count: 0 })])).toEqual([]);
});
