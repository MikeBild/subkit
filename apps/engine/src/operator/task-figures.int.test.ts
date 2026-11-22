import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { taskGrants, taskRuns, tasks } from "../db/schema/tasks.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { readOperatingFigures } from "./operating-figures.ts";
import {
  getOperationalOverview,
  invalidateOperationalOverview,
  type OperationalOverview,
  taskStartsHeld,
} from "./operational-overview.ts";

const FINGERPRINT = "c".repeat(64);
const OTHER_FINGERPRINT = "d".repeat(64);
const OWNER = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
const HOUR = 3_600_000;

let testDb: TestDb;
let tenant_id = "";
let other_tenant_id = "";
let traceCounter = 0;

type TaskInsert = Partial<typeof tasks.$inferInsert>;
type GrantInsert = Partial<typeof taskGrants.$inferInsert>;

async function seedTask(values: TaskInsert = {}, tenant = tenant_id): Promise<string> {
  const [row] = await testDb.db
    .insert(tasks)
    .values({
      locale: "de",
      tenant_id: tenant,
      name: "Confidential acquisition digest",
      owner_id: OWNER,
      goal: "goal",
      done_when: "done",
      plan: { title: "Digest", goal: "goal", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: FINGERPRINT,
      schedule_cron: "0 7 * * 1",
      schedule_timezone: "Europe/Berlin",
      ...values,
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task seed failed");
  return row.id;
}

async function seedGrant(task_id: string, values: GrantInsert = {}): Promise<void> {
  await testDb.db.insert(taskGrants).values({
    tenant_id,
    task_id,
    fingerprint: FINGERPRINT,
    environment: "prod",
    created_by: OWNER,
    valid_from: new Date(FROZEN_NOW - HOUR),
    ...values,
  });
}

async function seedRun(
  task_id: string,
  state: (typeof taskRuns.$inferInsert)["state"],
  created_at: Date,
  tenant = tenant_id,
  trigger: (typeof taskRuns.$inferInsert)["trigger"] = "cron",
): Promise<void> {
  traceCounter += 1;
  await testDb.db.insert(taskRuns).values({
    tenant_id: tenant,
    task_id,
    task_revision: 1,
    fingerprint: FINGERPRINT,
    trigger,
    state,
    deadline_at: new Date(created_at.getTime() + 4 * HOUR),
    trace_id: traceCounter.toString(16).padStart(32, "0"),
    created_at,
    updated_at: created_at,
  });
}

async function snapshot(): Promise<OperationalOverview> {
  invalidateOperationalOverview(tenant_id);
  return getOperationalOverview(testDb.db, tenant_id);
}

async function decisions() {
  const overview = await snapshot();
  return {
    blocked: overview.core.blocked.value,
    overdue: overview.core.overdue.value,
    other: overview.core.other_decisions.value,
    health: overview.core.health.state,
    causes: overview.core.health.causes,
    wire: JSON.stringify(overview),
  };
}

const OLD = new Date(FROZEN_NOW - 100 * HOUR);

beforeAll(async () => {
  testDb = await createTestDb("operator_task_figures");
  tenant_id = (await seedTenant(testDb.db, { slug: "t-task-figures", display_name: "Tasks" })).id;
  other_tenant_id = (
    await seedTenant(testDb.db, { slug: "t-task-figures-other", display_name: "Other" })
  ).id;
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.db.delete(taskGrants).where(eq(taskGrants.tenant_id, tenant_id));
  await testDb.db.delete(taskGrants).where(eq(taskGrants.tenant_id, other_tenant_id));
  await testDb.db.delete(tasks).where(eq(tasks.tenant_id, tenant_id));
  await testDb.db.delete(tasks).where(eq(tasks.tenant_id, other_tenant_id));
});

describe("scheduled tasks without a standing permission in the operational overview", () => {
  test("without tasks there is no decision", async () => {
    expect(await decisions()).toMatchObject({ blocked: 0, overdue: 0, other: 0, causes: [] });
  });

  test("an ungranted scheduled task is an open decision, never a blocker or a health cause", async () => {
    const taskId = await seedTask();
    const state = await decisions();
    expect(state).toMatchObject({ blocked: 0, overdue: 0, other: 1, causes: [] });
    expect(state.health).not.toBe("critical");
    expect(state.wire).not.toContain(taskId);
    expect(state.wire).not.toContain(OWNER);
    expect(state.wire).not.toContain("Confidential acquisition digest");
    expect(state.wire).not.toContain("held_task_schedule");
  });

  test("it becomes overdue after 72 hours like every other open decision", async () => {
    await seedTask({ created_at: OLD, updated_at: OLD });
    await seedTask();
    expect(await decisions()).toMatchObject({ blocked: 0, overdue: 1, other: 1 });
  });

  test("the 72 hours count from the moment the permission ended, not from the task's creation", async () => {
    const expired = await seedTask({ created_at: OLD, updated_at: OLD });
    await seedGrant(expired, {
      valid_from: new Date(OLD.getTime() + HOUR),
      valid_until: new Date(Date.now() - HOUR), // allow-wall-clock: the 72 hours count from this end against SQL now()
    });
    const revoked = await seedTask({ created_at: OLD, updated_at: OLD });
    await seedGrant(revoked, {
      valid_from: OLD,
      revoked_at: new Date(Date.now() - 2 * HOUR), // allow-wall-clock: the 72 hours count from this end against SQL now()
      revoked_by: OWNER,
    });
    expect(await decisions()).toMatchObject({ blocked: 0, overdue: 0, other: 2 });
  });

  test("a valid standing permission closes the decision", async () => {
    const openEnded = await seedTask();
    await seedGrant(openEnded);
    const limited = await seedTask();
    await seedGrant(limited, {
      valid_until: new Date(Date.now() + HOUR), // allow-wall-clock: must lie after SQL now() to be valid
      max_runs: 5,
      reserved_runs: 4,
    });
    expect(await decisions()).toMatchObject({ blocked: 0, overdue: 0, other: 0 });
  });

  test("an expired, used up, revoked, outdated, wrong-environment or not yet valid permission does not", async () => {
    const expired = await seedTask();
    await seedGrant(expired, {
      valid_from: new Date(FROZEN_NOW),
      valid_until: new Date(Date.now() - HOUR), // allow-wall-clock: ended before SQL now(), within the last 72 hours
    });
    const exhausted = await seedTask();
    await seedGrant(exhausted, { max_runs: 3, reserved_runs: 3 });
    const revoked = await seedTask();
    await seedGrant(revoked, { revoked_at: new Date(), revoked_by: OWNER }); // allow-wall-clock: revoked within the last 72 hours of SQL now()
    const outdated = await seedTask();
    await seedGrant(outdated, { fingerprint: OTHER_FINGERPRINT });
    const wrongEnvironment = await seedTask();
    await seedGrant(wrongEnvironment, { environment: "dev" });
    const notYetValid = await seedTask();
    await seedGrant(notYetValid, { valid_from: new Date(Date.now() + HOUR) }); // allow-wall-clock: must lie after SQL now() to be not yet valid
    expect(await decisions()).toMatchObject({ blocked: 0, other: 6, causes: [] });
  });

  test("a task that is not waiting for a scheduled start is never counted", async () => {
    await seedTask({ schedule_cron: null, schedule_timezone: null });
    await seedTask({
      paused_at: new Date(FROZEN_NOW),
      paused_by: OWNER,
      paused_reason: "owner_request",
    });
    await seedTask({ lifecycle: "archived" });
    await seedTask({}, other_tenant_id);
    expect(await decisions()).toMatchObject({ blocked: 0, overdue: 0, other: 0 });
  });

  test("a one-time task counts until its run started, whatever the sweep stamped", async () => {
    const runAt = new Date(FROZEN_NOW);
    const once = { schedule_cron: null, schedule_timezone: null, schedule_run_at: runAt };
    await seedTask({ ...once, schedule_run_at: new Date(runAt.getTime() + 3 * HOUR) });
    await seedTask({ ...once, last_claimed_at: new Date(runAt.getTime() + HOUR) });
    await seedTask({ ...once, last_claimed_at: new Date(runAt.getTime() - HOUR) });
    const started = await seedTask({ ...once, last_claimed_at: new Date(runAt.getTime() + HOUR) });
    await seedRun(started, "completed", new Date(runAt.getTime() + HOUR), tenant_id, "once");
    const rescheduled = await seedTask(once);
    await seedRun(rescheduled, "completed", new Date(runAt.getTime() - HOUR), tenant_id, "once");
    const manualOnly = await seedTask(once);
    await seedRun(manualOnly, "completed", new Date(runAt.getTime() + HOUR), tenant_id, "manual");
    expect(await decisions()).toMatchObject({ blocked: 0, other: 5 });
  });

  test("only a stored hold on an active, unpaused, scheduled task blocks", async () => {
    const since = new Date(FROZEN_NOW);
    const held = { admission_hold_reason: "grant_required", admission_hold_since: since };
    await seedTask();
    await seedTask({ ...held, paused_at: new Date(FROZEN_NOW), paused_reason: "owner_request" });
    await seedTask({ ...held, lifecycle: "archived" });
    await seedTask({ ...held, schedule_cron: null, schedule_timezone: null });
    expect((await testDb.db.execute(taskStartsHeld(tenant_id))).rows).toEqual([]);
    expect(await decisions()).toMatchObject({ blocked: 0 });
    await seedTask(held);
    const rows = await testDb.db.execute(taskStartsHeld(tenant_id));
    expect(rows.rows).toHaveLength(1);
    expect(await decisions()).toMatchObject({ blocked: 1 });
  });
});

describe("task runs in the operating figures", () => {
  const from = new Date("2026-05-01T00:00:00.000Z");
  const to = new Date("2026-05-02T00:00:00.000Z");
  const inside = new Date("2026-05-01T10:00:00.000Z");

  test("without runs the three counts are zero", async () => {
    const figures = await readOperatingFigures(testDb.db, tenant_id, { from, to });
    expect(figures.task_runs).toEqual({ total: 0, completed: 0, failed: 0 });
  });

  test("runs started in the window are counted in total, completed and failed", async () => {
    const taskId = await seedTask();
    const foreignTask = await seedTask({}, other_tenant_id);
    await seedRun(taskId, "completed", inside);
    await seedRun(taskId, "completed", new Date(inside.getTime() + HOUR));
    await seedRun(taskId, "failed", inside);
    await seedRun(taskId, "aborted", inside);
    await seedRun(taskId, "result_ready", inside);
    await seedRun(taskId, "waiting", inside);
    await seedRun(taskId, "completed", new Date(from.getTime() - 1));
    await seedRun(taskId, "failed", to);
    await seedRun(foreignTask, "failed", inside, other_tenant_id);
    const figures = await readOperatingFigures(testDb.db, tenant_id, { from, to });
    expect(figures.task_runs).toEqual({ total: 6, completed: 2, failed: 1 });
    expect(figures.runs.total).toBe(0);
    const later = await readOperatingFigures(testDb.db, tenant_id, {
      from: to,
      to: new Date(to.getTime() + 24 * HOUR),
    });
    expect(later.task_runs).toEqual({ total: 1, completed: 0, failed: 1 });
  });
});
