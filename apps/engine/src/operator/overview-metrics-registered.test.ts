import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getMetrics } from "../observability/metrics.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import {
  getOperationalOverview,
  invalidateOperationalOverview,
  type OperationalOverview,
} from "./operational-overview.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("overview_metrics_registered");
  tenant_id = (
    await seedTenant(testDb.db, { slug: "t-overview-metrics", display_name: "Overview metrics" })
  ).id;
});

afterAll(async () => {
  await testDb.cleanup();
});

function exportedNames(snapshot: OperationalOverview): string[] {
  return [
    snapshot.core.blocked,
    snapshot.core.failing,
    snapshot.core.overdue,
    snapshot.core.other_decisions,
    snapshot.core.health,
    snapshot.core.data_freshness,
    ...snapshot.sections.flatMap((section) => section.metrics),
  ].map((entry) => entry.prometheus.name);
}

test("every metric the overview exports is registered", async () => {
  invalidateOperationalOverview(tenant_id);
  const snapshot = await getOperationalOverview(testDb.db, tenant_id);
  const rendered = getMetrics().render();
  const unregistered = exportedNames(snapshot).filter(
    (name) => !rendered.includes(`# TYPE ${name} gauge`),
  );
  expect(unregistered, `written but never registered: ${unregistered.join(", ")}`).toEqual([]);
});
