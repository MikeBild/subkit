// The overview counts what the decisions queue counts.
//
// It did not. The overview asked its own SQL — `finished_at`, `failed` and
// `timed_out`, 24 hours — while the queue read the digest — `created_at`,
// `failed` only, 500 rows, seven days. On one production installation the
// overview therefore said "production incidents: 0" while the badge counted
// two failing workflows, and nothing on either screen could reconcile them.
//
// This holds the two together on one seeded history: whatever the digest
// reports as a failing scheduled workflow is what the overview's tile says.
// It would have failed on the old code for the plainest reason — there was no
// tile, and the numbers came from two different queries.

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  executionSteps,
  executions,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
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

/** One failed run and the step that stopped it. */
async function seedFailure(args: {
  source_kind: string;
  request_source: string;
  step_key: string;
  code: string;
  /** How long ago it failed. The old overview looked back 24 hours only. */
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

  // Two runs of one cause, four days back: inside the queue's window and
  // outside the 24 hours the overview used to look at. One group, not two.
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
  // A second cause in the same workflow — a separate decision.
  await seedFailure({
    source_kind: "saved",
    request_source: "scheduler",
    step_key: "store",
    code: "storage_refused",
    hoursAgo: 30,
  });
  // Someone trying it out by hand, and an authoring trial. Neither is an
  // operational decision, and counting them here is how a real one gets buried.
  // Both carry causes of their own: a group is keyed by workflow, step and
  // error code, so reusing a scheduled cause here would merge the origins
  // instead of testing that these two are excluded.
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
  const digest = await buildOperatorHealthDigest(testDb.db, tenant_id, {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
    audit: false,
  });
  const queue = failingScheduledGroups(digest.failure_groups);
  // Two scheduled causes; the manual run and the authoring trial are not
  // decisions, and the two runs of one cause are one.
  expect(queue.map((group) => group.step_key).sort()).toEqual(["fetch", "store"]);
  expect(queue.find((group) => group.step_key === "fetch")?.count).toBe(2);

  const overview = await getOperationalOverview(testDb.db, tenant_id);
  expect(overview.core.failing.value).toBe(queue.length);
  // Named and reachable: a number that says nothing about what it counts is
  // what sent people to a list of eleven thousand runs.
  expect(overview.core.failing.drilldown.path).toBe("/cockpit/decisions?bucket=failing");
  expect(overview.core.failing.severity).toBe("urgent");
});

test("a failure four days old still counts — the window is the queue's, not a day", async () => {
  const overview = await getOperationalOverview(testDb.db, tenant_id);
  // The oldest seeded cause is 96 hours back. Under the overview's former
  // 24-hour SQL this tile would read 1 instead of 2, and the badge beside it
  // would still say 2.
  expect(overview.core.failing.value).toBe(2);
  expect(DECISION_FAILURE_WINDOW_HOURS).toBe(168);
});

test("retrying it by hand does not delete the record that it broke", () => {
  // The shape that made this a bug: an operator sees a scheduled step failing
  // and runs it once from the CLI to look at it. The group is keyed by
  // workflow, step and error code, so that retry lands in the SAME group and
  // merges its origin to "mixed" — and filtering on `origin === "scheduled"`
  // dropped the row from the queue and the tile at once, while the schedule
  // went on failing every hour. What decides is whether the scheduler ever
  // started one of these runs.
  return (async () => {
    await seedFailure({
      source_kind: "saved",
      request_source: "cli",
      step_key: "store",
      code: "storage_refused",
      hoursAgo: 1,
    });
    invalidateOperationalOverview(tenant_id);
    const digest = await buildOperatorHealthDigest(testDb.db, tenant_id, {
      window_hours: DECISION_FAILURE_WINDOW_HOURS,
      audit: false,
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
  // Mixed for the other reason: tried by hand and tried in the editor, never on
  // a schedule. Widening the filter to "mixed" would have counted this one.
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
  const digest = await buildOperatorHealthDigest(testDb.db, tenant_id, {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
    audit: false,
  });
  const probe = digest.failure_groups.find((group) => group.step_key === "probe");
  expect(probe?.origin).toBe("mixed");
  expect(probe?.scheduled_count).toBe(0);
  const queue = failingScheduledGroups(digest.failure_groups);
  expect(queue.map((group) => group.step_key).sort()).toEqual(["fetch", "store"]);
});
