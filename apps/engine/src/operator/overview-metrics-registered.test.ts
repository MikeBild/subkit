// Every figure the overview can export is a metric the registry knows.
//
// The repair tile changed identity — from repairs waiting for review to the
// share of decided repairs that were applied — and its Prometheus name changed
// with it. The registry kept the old name. From then on every overview write
// logged "attempt to write to an unregistered metric" and the figure never
// reached a scrape: 121 warnings in the first hour on production, for weeks.
// Two lists had to agree and nothing held them together.
//
// This builds a real overview and checks every name in it — core tiles and
// every section metric, with or without a value today — against what the
// registry renders.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getMetrics } from "../observability/metrics.ts";
import {
  getOperationalOverview,
  invalidateOperationalOverview,
  type OperationalOverview,
} from "./operational-overview.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("overview_metrics_registered");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-overview-metrics", display_name: "Overview metrics" })
    .returning();
  if (!tenant) throw new Error("tenant fixture missing");
  tenant_id = tenant.id;
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
