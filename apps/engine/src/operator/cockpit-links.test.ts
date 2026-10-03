// The Cockpit addresses the engine hands out. The run list and one run are
// overlays on Übersicht (`/cockpit?runs=all`, `/cockpit?run=<id>`); an account
// sign-in is renewed on the connector that uses it. An old address renders
// "page not found", so every producer has to name the new one.

import { expect, test } from "bun:test";
import { attentionHref } from "./attention-readers.ts";
import { cockpitRunsHref } from "./operating-figures.ts";

test("the run list is the overlay on Übersicht, narrowed by its query", () => {
  expect(cockpitRunsHref({})).toBe("/cockpit?runs=all");
  expect(cockpitRunsHref({ status: "failed", started_from: "2026-01-01T00:00:00.000Z" })).toBe(
    "/cockpit?runs=all&status=failed&started_from=2026-01-01T00%3A00%3A00.000Z",
  );
  expect(attentionHref.failedRuns("w/1")).toBe("/cockpit?runs=all&workflow_id=w%2F1&status=failed");
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
