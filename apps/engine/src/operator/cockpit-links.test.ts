import { expect, test } from "bun:test";
import { attentionHref } from "./attention-readers.ts";
import { cockpitRunsHref } from "./operating-figures.ts";

test("the run list is the overlay on Übersicht, narrowed by its own query keys", () => {
  expect(cockpitRunsHref()).toBe("/cockpit?runs=all");
  expect(cockpitRunsHref({ status: "failed", startedFrom: "2026-01-01T00:00:00.000Z" })).toBe(
    "/cockpit?runs=all&runs_status=failed&runs_from=2026-01-01T00%3A00%3A00.000Z",
  );
  expect(cockpitRunsHref({ status: "failed", source: "scheduler" })).toBe(
    "/cockpit?runs=all&runs_status=failed&runs_source=scheduler",
  );
  expect(attentionHref.failedRuns("w/1")).toBe(
    "/cockpit?runs=all&runs_workflow=w%2F1&runs_status=failed",
  );
});

test("a run link never claims a query key the page under the overlay owns", () => {
  const href = cockpitRunsHref({
    workflowId: "w",
    status: "failed",
    source: "api",
    q: "x",
    startedFrom: "a",
    startedTo: "b",
  });
  const keys = [...new URL(href, "http://cockpit.example").searchParams.keys()];
  expect(keys).toEqual([
    "runs",
    "runs_workflow",
    "runs_status",
    "runs_source",
    "runs_q",
    "runs_from",
    "runs_to",
  ]);
});

test("an account sign-in leads to the one connector that uses it, else the list", () => {
  expect(attentionHref.connection(["c1"])).toBe("/cockpit/connectors/c1");
  expect(attentionHref.connection(["c1", "c2"])).toBe("/cockpit/connectors");
  expect(attentionHref.connection([])).toBe("/cockpit/connectors");
});

test("no attention address names a page the Cockpit no longer has", () => {
  const all = JSON.stringify(attentionHref, (_key, value) =>
    typeof value === "function" ? value(["x"], null) : value,
  );
  expect(all).not.toMatch(/\/cockpit\/(runs|connections|notifications)\b|section=grants/);
});
