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

/** One successful run. `request_source` decides whether it can resolve anything. */
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

test("a manual success does not close a scheduled failure", async () => {
  // Ordered before the scheduled-recovery test on purpose: this is the
  // over-correction guard. Re-running it by hand is how an operator checks
  // whether a fix took. It proves the workflow CAN work when driven by hand —
  // not that the thing which fires it unattended has recovered. Accepting it
  // would close the decision on the strength of the operator's own probe.
  await seedSuccess({ request_source: "cli", hoursAgo: 1 });
  invalidateOperationalOverview(tenant_id);
  const digest = await buildOperatorHealthDigest(testDb.db, tenant_id, {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
    audit: false,
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
  // The production shape: the grant was re-issued and the schedule has run
  // clean since, but the tile went on counting the old cause — an open
  // decision with no action left that could close it. A group knows
  // `last_seen` and, until now, nothing about what happened afterwards.
  await seedSuccess({ request_source: "scheduler", hoursAgo: 0 });
  invalidateOperationalOverview(tenant_id);
  const digest = await buildOperatorHealthDigest(testDb.db, tenant_id, {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
    audit: false,
  });

  // It leaves the queue and the tile together — the parity this file exists
  // for holds through the recovery, not only through the failure.
  expect(failingScheduledGroups(digest.failure_groups)).toHaveLength(0);
  const overview = await getOperationalOverview(testDb.db, tenant_id);
  expect(overview.core.failing.value).toBe(0);

  // And it is still in the history, saying when it recovered. Dropping the
  // group entirely would have replaced one silence with another: nobody could
  // then see what had broken, or that it was over.
  const fetchGroup = digest.failure_groups.find((group) => group.step_key === "fetch");
  expect(fetchGroup).toBeDefined();
  expect(fetchGroup?.resolved_at).not.toBeNull();
  expect(digest.rendered).toContain("last ran clean on its schedule");

  // The trial runs never had a schedule to recover on, and must not be
  // stamped as though they did.
  const probe = digest.failure_groups.find((group) => group.step_key === "probe");
  expect(probe?.resolved_at).toBeNull();
});

test("a busy neighbour cannot bury another workflow's recovery", async () => {
  // The shape a capped, time-ordered list of successes gets wrong: two failing
  // workflows, one of them chatty. Reading runs oldest-first fills the cap from
  // the global floor, so the chatty workflow's successes evict the one row that
  // proves the quiet one recovered — and it stays counted forever on exactly
  // the installations busy enough to need the answer.
  const [noisy] = await testDb.db
    .insert(workflows)
    .values({ tenant_id, slug: "chatty", name: "Chatty", lifecycle: "active" })
    .returning();
  const [noisyVersion] = await testDb.db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id: noisy!.id, version: 1, dag: { name: "Chatty", steps: [] } })
    .returning();
  const at = (hoursAgo: number) => new Date(getTestNow() - hoursAgo * 60 * 60 * 1000);

  // The quiet workflow: one failure, then one clean scheduled run.
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

  // The loud neighbour: far more clean scheduled runs, all OLDER, on the
  // workflow the rest of this file already seeded as failing.
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
  const digest = await buildOperatorHealthDigest(testDb.db, tenant_id, {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
    audit: false,
  });
  const quiet = digest.failure_groups.find((group) => group.step_key === "ping");
  expect(quiet).toBeDefined();
  expect(quiet?.resolved_at).not.toBeNull();
});

test("a workflow that was deleted stops asking to be decided about", async () => {
  // "It keeps failing and cannot be fixed here" has exactly one remedy that is
  // always available: remove the thing. On production that did not work — the
  // runs that failed are still in the history, so the group outlived its own
  // subject and sat in the queue with no action left that could close it.
  //
  // The mirror image of a cause that healed: the group knew what failed and
  // nothing about whether the workflow still exists.
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

  const before = await buildOperatorHealthDigest(testDb.db, tenant_id, {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
    audit: false,
  });
  expect(
    failingScheduledGroups(before.failure_groups).some((g) => g.workflow_id === gone!.id),
  ).toBe(true);

  // Soft-deleted, the way the product deletes: the history stays readable, and
  // only the open decision goes.
  await testDb.db
    .update(workflows)
    .set({ deleted_at: new Date(getTestNow()) })
    .where(eq(workflows.id, gone!.id));

  const after = await buildOperatorHealthDigest(testDb.db, tenant_id, {
    window_hours: DECISION_FAILURE_WINDOW_HOURS,
    audit: false,
  });
  expect(after.failure_groups.some((g) => g.workflow_id === gone!.id)).toBe(false);
  // And ONLY that one went. Guarding against over-correction by counting the
  // queue would be wrong here: earlier tests in this file legitimately empty
  // it, so the check is that every other group survived, not that some
  // remain.
  const survivors = (list: typeof after.failure_groups) =>
    list
      .filter((g) => g.workflow_id !== gone!.id)
      .map((g) => g.signature)
      .sort();
  expect(survivors(after.failure_groups)).toEqual(survivors(before.failure_groups));
});
