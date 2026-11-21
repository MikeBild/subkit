import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { events, webhooksInbound, workflows, workflowsSchedules } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { recordInboundAdmission } from "../../webhooks/inbound/admission-state.ts";
import { createInbound } from "../../webhooks/inbound/service.ts";
import { createSchedule, deleteSchedule, updateSchedule } from "../repo.ts";
import { recordScheduleAdmission } from "../schedule-admission-state.ts";

let testDb: TestDb;
let tenant_id: string;
let workflow_id: string;

beforeAll(async () => {
  testDb = await createTestDb("automation_change_events");
  const t = await seedTenant(testDb.db, {
    slug: "t-automation-events",
    display_name: "AutomationEvents",
  });
  tenant_id = t.id;
  const [wf] = await testDb.db
    .insert(workflows)
    .values({ tenant_id, slug: "nightly", name: "Nightly", lifecycle: "active" })
    .returning();
  workflow_id = wf!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

async function changesSince(id: number) {
  const rows = await testDb.db
    .select({ id: events.id, type: events.type, payload: events.payload })
    .from(events)
    .where(and(eq(events.tenant_id, tenant_id), eq(events.channel, "resource.lifecycle")))
    .orderBy(events.id);
  return rows.filter((row) => row.id > id).map(({ type, payload }) => ({ type, payload }));
}

async function newestId(): Promise<number> {
  const rows = await testDb.db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.tenant_id, tenant_id));
  return rows.reduce((max, row) => Math.max(max, row.id), 0);
}

test("a schedule's create, edit, release and delete each announce themselves", async () => {
  const before = await newestId();
  const created = await createSchedule(testDb.db, {
    creator: null,
    tenant_id,
    workflow_id,
    cron: "0 3 * * *",
  });
  const schedule_id = created.row.id;
  await updateSchedule(testDb.db, tenant_id, schedule_id, { paused: true });
  await updateSchedule(testDb.db, tenant_id, schedule_id, { paused: false });

  const claimed_at = new Date("2026-01-01T03:00:00.000Z");
  await testDb.db
    .update(workflowsSchedules)
    .set({
      last_enqueued_at: claimed_at,
      admission_hold: {
        reason_code: "execution_authority_required",
        observed_at: claimed_at.toISOString(),
      },
    })
    .where(eq(workflowsSchedules.id, schedule_id));
  expect(
    await recordScheduleAdmission(testDb.db, { tenant_id, schedule_id, claimed_at }, null),
  ).toBe(true);

  await deleteSchedule(testDb.db, tenant_id, schedule_id);
  const expected = { type: "workflow.automation_changed", payload: { workflow_id, schedule_id } };
  expect(await changesSince(before)).toEqual([expected, expected, expected, expected, expected]);
});

test("a held inbound hook announces its release", async () => {
  const hook = await createInbound(
    {
      tenant_id,
      actor_id: null,
      slug: "incoming",
      workflow_id,
      verifier: "hmac",
      secret: "a-hook-secret-that-stays-out",
    },
    testDb.db,
  );
  await testDb.db
    .update(webhooksInbound)
    .set({
      admission_hold: {
        reason_code: "execution_authority_required",
        observed_at: new Date("2026-01-01T03:00:00.000Z").toISOString(),
      },
    })
    .where(eq(webhooksInbound.id, hook.id));
  const before = await newestId();
  expect(
    await recordInboundAdmission(
      testDb.db,
      { tenant_id, inbound_id: hook.id, observed_at: new Date("2026-01-01T03:01:00.000Z") },
      null,
    ),
  ).toBe(true);
  expect(
    await recordInboundAdmission(
      testDb.db,
      { tenant_id, inbound_id: hook.id, observed_at: new Date("2026-01-01T03:02:00.000Z") },
      null,
    ),
  ).toBe(false);
  expect(await changesSince(before)).toEqual([
    { type: "workflow.automation_changed", payload: { workflow_id, hook_id: hook.id } },
  ]);
});
