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
  last_seen: "2026-09-23T10:00:00.000Z",
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

test("the link leads to those runs, not to every run", () => {
  // "Production incidents: 1" pointed at eleven thousand rows. A number that
  // names something has to lead to that something.
  const [failing] = failingWorkflows([group({})]);
  expect(failing?.runs_href).toBe("/cockpit/runs?status=failed&q=Product%20analytics%20hourly");
  // Without a name there is nothing to search for, but the status still narrows.
  const [unnamed] = failingWorkflows([group({ workflow_name: null })]);
  expect(unnamed?.runs_href).toBe("/cockpit/runs?status=failed");
});

test("an authoring trial that failed is feedback, not an incident", () => {
  // Mixing the two is how a real incident ends up buried among experiments.
  expect(failingWorkflows([group({ origin: "authoring" })])).toEqual([]);
  expect(failingWorkflows([group({ origin: "manual" })])).toEqual([]);
});

test("the worst comes first, and ties keep a stable order", () => {
  const rows = failingWorkflows([
    group({ signature: "b", count: 3 }),
    group({ signature: "a", count: 76 }),
    group({ signature: "c", count: 3 }),
  ]);
  expect(rows.map((row) => row.key)).toEqual(["a", "b", "c"]);
});

test("nothing to report is an empty list", () => {
  expect(failingWorkflows([])).toEqual([]);
  expect(failingWorkflows(null)).toEqual([]);
  expect(failingWorkflows(undefined)).toEqual([]);
  // A group the engine counted at zero is not a failure anyone can act on.
  expect(failingWorkflows([group({ count: 0 })])).toEqual([]);
});
