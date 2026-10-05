import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getOperationalOverview, type OperationalOverview } from "./operational-overview.ts";

let testDb: TestDb;
let overview: OperationalOverview;

beforeAll(async () => {
  testDb = await createTestDb("incidents_drilldown");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-incidents-drilldown", display_name: "Incidents" })
    .returning();
  overview = await getOperationalOverview(testDb.db, tenant!.id);
});

afterAll(async () => {
  await testDb.cleanup();
});

function pathOf(metricId: string): string {
  const metric = overview.sections
    .flatMap((section) => section.metrics)
    .find((candidate) => candidate.id === metricId);
  if (!metric) throw new Error(`no metric ${metricId}`);
  return metric.drilldown.path;
}

function queryOf(metricId: string): URLSearchParams {
  return new URLSearchParams(pathOf(metricId).split("?")[1] ?? "");
}

test("production incidents lead to failed SCHEDULED runs, not to every failure", () => {
  const query = queryOf("executions.incidents_24h");
  expect(query.get("runs")).toBe("all");
  expect(query.get("runs_status")).toBe("failed");
  expect(query.get("runs_source")).toBe("scheduler");
});

test("the two failure counts do not lead to the same list", () => {
  expect(pathOf("executions.incidents_24h")).not.toBe(pathOf("executions.trial_failures_24h"));
  expect(queryOf("executions.trial_failures_24h").get("runs_status")).toBe("failed");
});

test("a run drilldown claims no query key of the page beneath the overlay", () => {
  for (const id of [
    "executions.total_24h",
    "executions.success_ratio",
    "executions.incidents_24h",
    "executions.trial_failures_24h",
  ])
    for (const key of queryOf(id).keys())
      expect(key === "runs" || key.startsWith("runs_")).toBe(true);
});

test("a 24-hour metric does not bake its window into the link", () => {
  expect(pathOf("executions.incidents_24h")).not.toMatch(/since=|from=|after=/);
});
