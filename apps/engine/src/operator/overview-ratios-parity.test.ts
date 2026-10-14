import { afterAll, beforeAll, expect, test } from "bun:test";
import { AuditAction } from "../audit/index.ts";
import { listConnectors } from "../connectors/service.ts";
import {
  auditLog,
  connectors,
  executions,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
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
  await db
    .insert(executions)
    .values([
      run("succeeded", 2, 1),
      run("failed", 3, 2.5),
      run("running", 0.5, null),
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
  await db
    .insert(auditLog)
    .values([
      decision(AuditAction.PATCH_CANDIDATE_APPROVED, hoursAgo(4)),
      decision(AuditAction.PATCH_CANDIDATE_REJECTED, hoursAgo(5)),
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
  expect(success?.value).toBeCloseTo(1 / 2, 10);
  const component = overview.core.health.components.find(
    (c) => c.id === "executions.success_ratio",
  );
  expect(component?.raw_value).toBe(success?.value ?? Number.NaN);

  const repairs = sectionMetric(overview, "repairs.applied_ratio");
  expect(repairs?.value).toBe(figures.repairs.applied / figures.repairs.decided);
  expect(repairs?.value).toBe(0.5);
});

test("connector health and sign-in counts use their persisted states and tenant scope", async () => {
  await testDb.db.insert(connectors).values([
    {
      tenant_id,
      slug: "healthy",
      display_name: "Healthy",
      driver: "http",
      health_state: "ok",
    },
    {
      tenant_id,
      slug: "reauth-with-ok-health",
      display_name: "Needs sign-in",
      driver: "http",
      health_state: "ok",
      needs_reauth: true,
    },
    {
      tenant_id,
      slug: "degraded",
      display_name: "Degraded",
      driver: "http",
      health_state: "degraded",
    },
    {
      tenant_id,
      slug: "needs-update",
      display_name: "Needs update",
      driver: "http",
      health_state: "needs_update",
    },
    {
      tenant_id,
      slug: "disabled-reauth",
      display_name: "Disabled",
      driver: "http",
      enabled: false,
      needs_reauth: true,
    },
    {
      tenant_id: quiet_tenant_id,
      slug: "other-tenant-reauth",
      display_name: "Other tenant",
      driver: "http",
      needs_reauth: true,
    },
  ]);

  const bounds = resolveOperatingBounds({ window: "24h" }, new Date(getTestNow()));
  if (!bounds.ok) throw new Error(bounds.reason);
  const figures = await readOperatingFigures(testDb.db, tenant_id, bounds);
  expect(figures.connectors).toMatchObject({
    enabled: 4,
    not_ok: 3,
    needs_reauth: 1,
    healthy_percent: 25,
  });

  const notOk = await listConnectors(tenant_id, { health: "not_ok" }, testDb.db);
  expect(new Set(notOk.rows.map((connector) => connector.slug))).toEqual(
    new Set(["reauth-with-ok-health", "degraded", "needs-update"]),
  );
  const signIn = await listConnectors(tenant_id, { enabled: true, needs_reauth: true }, testDb.db);
  expect(signIn.rows.map((connector) => connector.slug)).toEqual(["reauth-with-ok-health"]);

  invalidateOperationalOverview(tenant_id);
  const overview = await getOperationalOverview(testDb.db, tenant_id);
  expect(
    overview.core.health.causes.find((cause) => cause.subject.name === "Needs sign-in"),
  ).toMatchObject({ reason: "needs_reauth", label: "Needs sign-in: needs reauth" });
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
