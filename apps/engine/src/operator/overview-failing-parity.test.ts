import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  executionSteps,
  executions,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import {
  buildOperatorHealthDigest,
  DECISION_FAILURE_WINDOW_HOURS,
  failingScheduledGroups,
} from "./health-digest.ts";
import { getOperationalOverview, invalidateOperationalOverview } from "./operational-overview.ts";

let testDb: TestDb;
let tenant_id: string;
let workflow_id: string;
let workflow_version_id: string;

async function seedFailure(args: {
  source_kind: string;
  request_source: string;
  step_key: string;
  code: string;
  hoursAgo: number;
}) {
  const at = new Date(getTestNow() - args.hoursAgo * 60 * 60 * 1000);
  const [exec] = await testDb.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      workflow_version_id,
      source_kind: args.source_kind,
      status: "failed",
      request_source: args.request_source,
      execution_mode: "dev",
      created_at: at,
      finished_at: at,
    })
    .returning();
  await testDb.db.insert(executionSteps).values({
    tenant_id,
    execution_id: exec!.id,
    step_key: args.step_key,
    step_index: 0,
    kind: "request",
    status: "failed",
    error: { code: args.code, message: `${args.code} on ${args.step_key}` },
  });
}

async function seedSuccess(args: { request_source: string; hoursAgo: number }) {
  const at = new Date(getTestNow() - args.hoursAgo * 60 * 60 * 1000);
  await testDb.db.insert(executions).values({
    tenant_id,
    workflow_id,
    workflow_version_id,
    source_kind: "saved",
    status: "succeeded",
    request_source: args.request_source,
    execution_mode: "dev",
    created_at: at,
    finished_at: at,
  });
}

beforeAll(async () => {
  testDb = await createTestDb("overview_failing_parity");
  const db = testDb.db;
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: "t-parity", display_name: "Parity" })
    .returning();
  tenant_id = tenant!.id;
  const [wf] = await db
    .insert(workflows)
    .values({ tenant_id, slug: "hourly-sync", name: "Hourly Sync", lifecycle: "active" })
    .returning();
  workflow_id = wf!.id;
  const [ver] = await db
    .insert(workflowVersions)
    .values({
      tenant_id,
      workflow_id,
      version: 1,
      dag: { name: "Hourly Sync", steps: [] },
    })
    .returning();
  workflow_version_id = ver!.id;

  await seedFailure({
    source_kind: "saved",
    request_source: "scheduler",
    step_key: "fetch",
    code: "http_4xx",
    hoursAgo: 96,
  });
  await seedFailure({
    source_kind: "saved",
    request_source: "scheduler",
    step_key: "fetch",
    code: "http_4xx",
    hoursAgo: 95,
  });
  await seedFailure({
    source_kind: "saved",
    request_source: "scheduler",
    step_key: "store",
    code: "storage_refused",
    hoursAgo: 30,
  });
  await seedFailure({
    source_kind: "saved",
    request_source: "cli",
    step_key: "probe",
    code: "http_5xx",
    hoursAgo: 12,
  });
  await seedFailure({
    source_kind: "draft",
    request_source: "chat",
    step_key: "transform",
    code: "transform_error",
    hoursAgo: 2,
  });
  invalidateOperationalOverview(tenant_id);
});

afterAll(async () => {
  await testDb.cleanup();
});

test("the overview tile and the decision queue report the same failing workflows", async () => {
  const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id), {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
  });
  const queue = failingScheduledGroups(digest.failure_groups);
  expect(queue.map((group) => group.step_key).sort()).toEqual(["fetch", "store"]);
  expect(queue.find((group) => group.step_key === "fetch")?.count).toBe(2);

  const overview = await getOperationalOverview(testDb.db, tenant_id);
  expect(overview.core.failing.value).toBe(queue.length);
  expect(overview.core.failing.drilldown.path).toBe("/cockpit");
  expect(overview.core.failing.severity).toBe("urgent");

  const failingCauses = overview.core.health.causes.filter((c) => c.kind === "failing_group");
  expect(failingCauses).toHaveLength(queue.length);
  for (const cause of failingCauses) {
    const group = queue.find((g) => g.signature === cause.id);
    expect(cause.subject).toEqual({
      kind: "workflow",
      id: group?.workflow_id ?? null,
      name: group?.workflow_name ?? null,
    });
    expect(cause.reason).toBe("failing");
    expect(cause.detail).toBe(group?.cause ?? "");
    expect(cause.cause_class).toBe(group?.cause_class ?? "unknown");
  }
});

test("a failure four days old still counts — the window is the queue's, not a day", async () => {
  const overview = await getOperationalOverview(testDb.db, tenant_id);
  expect(overview.core.failing.value).toBe(2);
  expect(DECISION_FAILURE_WINDOW_HOURS).toBe(168);
});

test("retrying it by hand does not delete the record that it broke", () => {
  return (async () => {
    await seedFailure({
      source_kind: "saved",
      request_source: "cli",
      step_key: "store",
      code: "storage_refused",
      hoursAgo: 1,
    });
    invalidateOperationalOverview(tenant_id);
    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id), {
      window_hours: DECISION_FAILURE_WINDOW_HOURS,
    });
    const store = digest.failure_groups.find((group) => group.step_key === "store");
    expect(store?.origin).toBe("mixed");
    expect(store?.count).toBe(2);
    expect(store?.scheduled_count).toBe(1);
    const queue = failingScheduledGroups(digest.failure_groups);
    expect(queue.map((group) => group.step_key).sort()).toEqual(["fetch", "store"]);
    const overview = await getOperationalOverview(testDb.db, tenant_id);
    expect(overview.core.failing.value).toBe(queue.length);
  })();
});

test("a group that never ran unattended is still not a decision", async () => {
  await seedFailure({
    source_kind: "saved",
    request_source: "cli",
    step_key: "probe",
    code: "http_5xx",
    hoursAgo: 3,
  });
  await seedFailure({
    source_kind: "step",
    request_source: "chat",
    step_key: "probe",
    code: "http_5xx",
    hoursAgo: 2,
  });
  invalidateOperationalOverview(tenant_id);
  const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id), {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
  });
  const probe = digest.failure_groups.find((group) => group.step_key === "probe");
  expect(probe?.origin).toBe("mixed");
  expect(probe?.scheduled_count).toBe(0);
  const queue = failingScheduledGroups(digest.failure_groups);
  expect(queue.map((group) => group.step_key).sort()).toEqual(["fetch", "store"]);
});

test("a manual success does not close a scheduled failure", async () => {
  await seedSuccess({ request_source: "cli", hoursAgo: 1 });
  invalidateOperationalOverview(tenant_id);
  const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id), {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
  });
  for (const group of failingScheduledGroups(digest.failure_groups)) {
    expect(group.resolved_at).toBeNull();
  }
  expect(
    failingScheduledGroups(digest.failure_groups)
      .map((g) => g.step_key)
      .sort(),
  ).toEqual(["fetch", "store"]);
});

test("a workflow that has run clean on its schedule since stops being a decision", async () => {
  await seedSuccess({ request_source: "scheduler", hoursAgo: 0 });
  invalidateOperationalOverview(tenant_id);
  const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id), {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
  });

  expect(failingScheduledGroups(digest.failure_groups)).toHaveLength(0);
  const overview = await getOperationalOverview(testDb.db, tenant_id);
  expect(overview.core.failing.value).toBe(0);

  const fetchGroup = digest.failure_groups.find((group) => group.step_key === "fetch");
  expect(fetchGroup).toBeDefined();
  expect(fetchGroup?.resolved_at).not.toBeNull();
  expect(digest.rendered).toContain("last ran clean on its schedule");

  const probe = digest.failure_groups.find((group) => group.step_key === "probe");
  expect(probe?.resolved_at).toBeNull();
});

test("a busy neighbour cannot bury another workflow's recovery", async () => {
  const [noisy] = await testDb.db
    .insert(workflows)
    .values({ tenant_id, slug: "chatty", name: "Chatty", lifecycle: "active" })
    .returning();
  const [noisyVersion] = await testDb.db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id: noisy!.id, version: 1, dag: { name: "Chatty", steps: [] } })
    .returning();
  const at = (hoursAgo: number) => new Date(getTestNow() - hoursAgo * 60 * 60 * 1000);

  const [quietFail] = await testDb.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id: noisy!.id,
      workflow_version_id: noisyVersion!.id,
      source_kind: "saved",
      status: "failed",
      request_source: "scheduler",
      execution_mode: "dev",
      created_at: at(20),
      finished_at: at(20),
    })
    .returning();
  await testDb.db.insert(executionSteps).values({
    tenant_id,
    execution_id: quietFail!.id,
    step_key: "ping",
    step_index: 0,
    kind: "request",
    status: "failed",
    error: { code: "http_503", message: "http_503 on ping" },
  });
  await testDb.db.insert(executions).values({
    tenant_id,
    workflow_id: noisy!.id,
    workflow_version_id: noisyVersion!.id,
    source_kind: "saved",
    status: "succeeded",
    request_source: "scheduler",
    execution_mode: "dev",
    created_at: at(2),
    finished_at: at(2),
  });

  await testDb.db.insert(executions).values(
    Array.from({ length: 40 }, (_, index) => ({
      tenant_id,
      workflow_id,
      workflow_version_id,
      source_kind: "saved",
      status: "succeeded" as const,
      request_source: "scheduler",
      execution_mode: "dev" as const,
      created_at: at(90 - index * 0.5),
      finished_at: at(90 - index * 0.5),
    })),
  );

  invalidateOperationalOverview(tenant_id);
  const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id), {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
  });
  const quiet = digest.failure_groups.find((group) => group.step_key === "ping");
  expect(quiet).toBeDefined();
  expect(quiet?.resolved_at).not.toBeNull();
});

test("a workflow that was deleted stops asking to be decided about", async () => {
  const [gone] = await testDb.db
    .insert(workflows)
    .values({ tenant_id, slug: "retired", name: "Retired", lifecycle: "active" })
    .returning();
  const [version] = await testDb.db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id: gone!.id, version: 1, dag: { name: "Retired", steps: [] } })
    .returning();
  const at = new Date(getTestNow() - 3 * 60 * 60 * 1000);
  const [run] = await testDb.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id: gone!.id,
      workflow_version_id: version!.id,
      source_kind: "saved",
      status: "failed",
      request_source: "scheduler",
      execution_mode: "dev",
      created_at: at,
      finished_at: at,
    })
    .returning();
  await testDb.db.insert(executionSteps).values({
    tenant_id,
    execution_id: run!.id,
    step_key: "release",
    step_index: 0,
    kind: "request",
    status: "failed",
    error: { code: "http_4xx", message: "http 422" },
  });

  const before = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id), {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
  });
  expect(
    failingScheduledGroups(before.failure_groups).some((g) => g.workflow_id === gone!.id),
  ).toBe(true);

  await testDb.db
    .update(workflows)
    .set({ deleted_at: new Date(getTestNow()) })
    .where(eq(workflows.id, gone!.id));

  const after = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id), {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
  });
  expect(after.failure_groups.some((g) => g.workflow_id === gone!.id)).toBe(false);
  const survivors = (list: typeof after.failure_groups) =>
    list
      .filter((g) => g.workflow_id !== gone!.id)
      .map((g) => g.signature)
      .sort();
  expect(survivors(after.failure_groups)).toEqual(survivors(before.failure_groups));
});
