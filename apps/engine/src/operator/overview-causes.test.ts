// Red points at its cause.
//
// The health score and the freshness tile both linked to the operations page,
// which says "what it finds is on the overview" — a loop with no cause at
// either end. `data.freshness` was a constant 0 that could never turn red.
//
// Pinned here: no core link leads to the operations page; each health
// component links to what it measures; a seeded unhealthy connector is named
// in `causes`; and freshness turns stale when its source is old.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, selfHealingScans, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import {
  FRESHNESS_STALE_AFTER_SECONDS,
  getOperationalOverview,
  invalidateOperationalOverview,
  MAX_HEALTH_CAUSES,
  type OperationalOverview,
} from "./operational-overview.ts";

let testDb: TestDb;
let tenant_id: string;
let brokenConnectorId: string;
let scanId: string;

async function snapshot(): Promise<OperationalOverview> {
  invalidateOperationalOverview(tenant_id);
  return getOperationalOverview(testDb.db, tenant_id);
}

beforeAll(async () => {
  testDb = await createTestDb("overview_causes");
  const now = getTestNow();
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({
      slug: "t-overview-causes",
      display_name: "Causes",
      last_connector_reauth_scan_at: new Date(now - 60_000),
    })
    .returning();
  tenant_id = tenant!.id;
  const connector = (slug: string, health_state: string) => ({
    tenant_id,
    slug,
    display_name: slug,
    driver: "http",
    environment: "dev" as const,
    auth_type: "none" as const,
    base_url: `https://${slug}.test`,
    config: {},
    health_state,
  });
  const rows = await testDb.db
    .insert(connectors)
    .values([connector("healthy-api", "ok"), connector("broken-api", "needs_reauth")])
    .returning();
  brokenConnectorId = rows.find((row) => row.slug === "broken-api")!.id;
  const [scan] = await testDb.db
    .insert(selfHealingScans)
    .values({
      tenant_id,
      source: "scheduler",
      filters: { tenant_id },
      status: "succeeded",
      updated_at: new Date(now - 120_000),
    })
    .returning();
  scanId = scan!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

test("no core metric or health component drilldown leads to the operations page", async () => {
  const overview = await snapshot();
  const core = [
    overview.core.blocked,
    overview.core.failing,
    overview.core.overdue,
    overview.core.other_decisions,
    overview.core.health,
    overview.core.data_freshness,
  ];
  for (const metric of core) expect(metric.drilldown.path).not.toBe("/cockpit/operations");
  for (const component of overview.core.health.components)
    expect(component.drilldown.path).not.toBe("/cockpit/operations");
  for (const source of overview.core.data_freshness.sources)
    expect(source.drilldown.path).not.toBe("/cockpit/operations");

  const byId = new Map(overview.core.health.components.map((c) => [c.id, c.drilldown.path]));
  expect(byId.get("decisions.blocked")).toBe("/cockpit/decisions?bucket=blocked");
  expect(byId.get("executions.success_ratio")).toBe("/cockpit/runs?status=failed&source=scheduler");
  expect(byId.get("connectors.healthy_ratio")).toBe("/cockpit/connectors?health=not_ok");
  // The section tile of the same ratio leads to the same narrowed list: at 0 %
  // it links (a ratio at zero is the worst state), and the plain catalogue
  // would hand the reader every connector instead of the broken ones.
  const tile = overview.sections
    .flatMap((section) => section.metrics)
    .find((metric) => metric.id === "connectors.healthy_ratio");
  expect(tile?.drilldown.path).toBe("/cockpit/connectors?health=not_ok");
});

test("a historical repair ratio leads to decided repairs, not to the open queue", async () => {
  const overview = await snapshot();
  const repairs = overview.sections
    .flatMap((section) => section.metrics)
    .find((metric) => metric.id === "repairs.applied_ratio");
  expect(repairs?.drilldown.path.startsWith("/cockpit/audit?")).toBe(true);
  expect(repairs?.drilldown.path).not.toBe("/cockpit/decisions");
});

test("a seeded unhealthy connector appears in causes with a link to that connector", async () => {
  const overview = await snapshot();
  const causes = overview.core.health.causes;
  expect(causes.length).toBeLessThanOrEqual(MAX_HEALTH_CAUSES);
  const cause = causes.find((c) => c.kind === "connector" && c.id === brokenConnectorId);
  expect(cause?.label).toContain("broken-api");
  expect(cause?.drilldown.path).toBe(`/cockpit/connectors/${brokenConnectorId}`);
  // Only the unhealthy one — a healthy connector is not a cause.
  expect(causes.filter((c) => c.kind === "connector")).toHaveLength(1);
  // With connector health below 90 %, the score's own link is that component.
  expect(overview.core.health.drilldown.path).toBe("/cockpit/connectors?health=not_ok");
});

test("freshness is fresh on recent heartbeats and turns stale when its source is old", async () => {
  const fresh = await snapshot();
  expect(fresh.core.data_freshness.state).toBe("fresh");
  expect(fresh.core.data_freshness.severity).toBe("healthy");
  expect(fresh.core.data_freshness.value).toBeGreaterThan(0);

  const now = getTestNow();
  await testDb.db
    .update(selfHealingScans)
    .set({ updated_at: new Date(now - (FRESHNESS_STALE_AFTER_SECONDS + 600) * 1000) })
    .where(eq(selfHealingScans.id, scanId));

  const stale = await snapshot();
  const freshness = stale.core.data_freshness;
  expect(freshness.state).toBe("stale");
  expect(freshness.severity).toBe("critical");
  expect(freshness.value_state).toBe("stale");
  expect(freshness.value).toBeGreaterThan(FRESHNESS_STALE_AFTER_SECONDS);
  const scanSource = freshness.sources.find((s) => s.id === "self_healing.drift_scan");
  expect(scanSource?.state).toBe("stale");
  expect(freshness.sources.find((s) => s.id === "connectors.reauth_scan")?.state).toBe("fresh");
  // The tile's link names the stale source.
  expect(freshness.drilldown.path).toBe(scanSource?.drilldown.path ?? "missing source");
});
