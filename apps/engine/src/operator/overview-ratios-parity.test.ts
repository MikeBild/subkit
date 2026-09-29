// The overview's success and repair ratios are the Übersicht's figures.
//
// They were not. `GET /v1/stats/operating-figures` — the cockpit's bar and the
// MCP tool `get_operating_figures` — counts runs STARTED in the window and
// repairs DECIDED in it (the audit verbs). The overview asked its own SQL:
// runs FINISHED in the last 24 hours, and repairs by their stored status over
// all time. One installation therefore quoted two success rates and two repair
// rates for one question, depending on whether a person looked at the cockpit
// or a scrape looked at `/metrics`.
//
// This seeds a history on which the two definitions disagree and holds the
// overview — the section tile, the health component and the Prometheus
// projection — to the figures' counts. On the old SQL it fails: the success
// ratio read 2/3 (finished in the window) and the repair ratio was null (no
// patch candidate stored).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { AuditAction } from "../audit/index.ts";
import { auditLog, executions, tenants, workflows, workflowVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getMetrics } from "../observability/metrics.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { readOperatingFigures, resolveOperatingBounds } from "./operating-figures.ts";
import {
  getOperationalOverview,
  invalidateOperationalOverview,
  type OperationalOverview,
  projectOperationalOverviewMetrics,
} from "./operational-overview.ts";

let testDb: TestDb;
let tenant_id: string;
let quiet_tenant_id: string;

const hoursAgo = (hours: number): Date => new Date(getTestNow() - hours * 3_600_000);

beforeAll(async () => {
  testDb = await createTestDb("overview_ratios_parity");
  const db = testDb.db;
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: "t-ratios", display_name: "Ratios" })
    .returning();
  tenant_id = tenant!.id;
  const [quiet] = await db
    .insert(tenants)
    .values({ slug: "t-ratios-quiet", display_name: "Quiet" })
    .returning();
  quiet_tenant_id = quiet!.id;
  const [wf] = await db
    .insert(workflows)
    .values({ tenant_id, slug: "nightly", name: "Nightly", lifecycle: "active" })
    .returning();
  const [ver] = await db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id: wf!.id, version: 1, dag: { name: "Nightly", steps: [] } })
    .returning();

  const run = (
    status: "succeeded" | "failed" | "running",
    startedHoursAgo: number,
    finishedHoursAgo: number | null,
  ): typeof executions.$inferInsert => ({
    tenant_id,
    workflow_id: wf!.id,
    workflow_version_id: ver!.id,
    source_kind: "saved",
    status,
    request_source: "scheduler",
    execution_mode: "dev",
    created_at: hoursAgo(startedHoursAgo),
    started_at: hoursAgo(startedHoursAgo),
    finished_at: finishedHoursAgo === null ? null : hoursAgo(finishedHoursAgo),
  });
  await db.insert(executions).values([
    // Started and finished inside the window: both definitions count it.
    run("succeeded", 2, 1),
    run("failed", 3, 2.5),
    // Still running: started in the window, not finished — counted in the
    // total, but neither a success nor a failure for the rate.
    run("running", 0.5, null),
    // Started yesterday, finished today: the old SQL counted it, the figures
    // (started in the window) do not.
    run("succeeded", 30, 1),
  ]);

  const nextId = createDeterministicUuidFactory(7);
  const decision = (action: string, at: Date) => ({
    id: nextId(),
    tenant_id,
    actor_type: "user",
    action,
    resource_type: "patch_candidate",
    result: "success",
    ts: at,
  });
  await db.insert(auditLog).values([
    decision(AuditAction.PATCH_CANDIDATE_APPROVED, hoursAgo(4)),
    decision(AuditAction.PATCH_CANDIDATE_REJECTED, hoursAgo(5)),
    // Decided the day before: outside the window.
    decision(AuditAction.PATCH_CANDIDATE_AUTO_APPLIED, hoursAgo(48)),
  ]);
});

afterAll(async () => {
  await testDb.cleanup();
});

function sectionMetric(overview: OperationalOverview, id: string) {
  return overview.sections.flatMap((s) => s.metrics).find((m) => m.id === id);
}

test("the success and repair ratios are the operating figures' counts", async () => {
  invalidateOperationalOverview(tenant_id);
  const overview = await getOperationalOverview(testDb.db, tenant_id);
  const bounds = resolveOperatingBounds({ window: "24h" }, new Date(getTestNow()));
  if (!bounds.ok) throw new Error(bounds.reason);
  const figures = await readOperatingFigures(testDb.db, tenant_id, bounds);

  expect(figures.runs).toMatchObject({ total: 3, succeeded: 1, failed: 1, finished: 2 });
  expect(figures.repairs).toMatchObject({ decided: 2, applied: 1 });

  const success = sectionMetric(overview, "executions.success_ratio");
  expect(success?.value).toBeCloseTo(figures.runs.succeeded / figures.runs.finished, 10);
  // The running run counts neither way: one of the two that ended succeeded.
  expect(success?.value).toBeCloseTo(1 / 2, 10);
  // The health score weighs the same number, not a second copy of it.
  const component = overview.core.health.components.find(
    (c) => c.id === "executions.success_ratio",
  );
  expect(component?.raw_value).toBe(success?.value ?? Number.NaN);

  const repairs = sectionMetric(overview, "repairs.applied_ratio");
  expect(repairs?.value).toBe(figures.repairs.applied / figures.repairs.decided);
  expect(repairs?.value).toBe(0.5);
});

test("a ratio with nothing to count is scraped as NaN, not as its last value", async () => {
  invalidateOperationalOverview(tenant_id);
  invalidateOperationalOverview(quiet_tenant_id);
  projectOperationalOverviewMetrics(await getOperationalOverview(testDb.db, tenant_id));
  expect(getMetrics().render()).toMatch(/^subkit_operational_repairs_applied_ratio 0\.5$/m);

  const quiet = await getOperationalOverview(testDb.db, quiet_tenant_id);
  expect(sectionMetric(quiet, "repairs.applied_ratio")?.value).toBeNull();
  projectOperationalOverviewMetrics(quiet);
  expect(getMetrics().render()).toMatch(/^subkit_operational_repairs_applied_ratio NaN$/m);
  expect(getMetrics().render()).toMatch(/^subkit_operational_execution_success_ratio NaN$/m);
});
