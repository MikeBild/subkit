// Pins the invariant that a version rotation only reconciles trigger
// bindings when the def's `trigger` block ACTUALLY changes.
//
// The bug this guards against: `updateWorkflow` rotated the version and
// called `applyTriggerBindings` unconditionally; for a no-trigger
// (`request`) def that path DELETEs the `workflows_schedules` row. A
// schedule bound OUT-OF-BAND (via `createSchedule`, because it carries a
// workflow `input` the inline ScheduleTrigger cannot express) was therefore
// destroyed by any step-only edit — `daily-do-resources-email` went dark for
// 11 days. The fix gates the reconcile on a real trigger-block change.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { tenants, workflowsSchedules } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createSchedule } from "../../scheduler/repo.ts";
import { createWorkflow, updateWorkflow } from "../service.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("schedule_binding_survives_edit");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-sbse", display_name: "T-SBSE" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A no-trigger ("request") workflow whose only step is editable. */
function requestDef(slug: string, expression: string) {
  return {
    name: slug,
    slug,
    steps: [
      { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
      { id: "shape", kind: "transform", language: "javascript", expression },
    ],
  };
}

/** Same shape but carrying an inline schedule trigger. */
function scheduledDef(slug: string, cron: string) {
  return {
    ...requestDef(slug, "return input.scope.fetch.data;"),
    trigger: { kind: "schedule", cron },
  };
}

function schedulesFor(workflow_id: string) {
  return ctx.db
    .select()
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
      ),
    );
}

describe("schedule binding survives a step-only edit", () => {
  test("out-of-band schedule survives a step-only edit (the daily-do case)", async () => {
    // request workflow → no inline trigger.
    const created = await createWorkflow(
      {
        tenant_id,
        def: requestDef("sbse-out-of-band", "return input.scope.fetch.data;"),
        actor_id: null,
      },
      ctx.db,
    );
    if ("errors" in created) throw new Error(`create: ${created.errors.join("; ")}`);
    const wfId = created.workflow.id;

    // Bind a schedule OUT OF BAND — carries a workflow input the inline
    // trigger schema cannot represent.
    const sched = await createSchedule(ctx.db, {
      tenant_id,
      workflow_id: wfId,
      cron: "0 19 * * *",
      timezone: "Europe/Berlin",
      input: { recipient_email: "x@y.com" },
    });
    expect(await schedulesFor(wfId)).toHaveLength(1);

    // A STEP-ONLY edit (changed transform expression, trigger unchanged →
    // still `request`) rotates the version. On current main this deletes the
    // schedule row (RED); with the trigger-change gate it must survive.
    const updated = await updateWorkflow(
      {
        tenant_id,
        id: wfId,
        def: requestDef("sbse-out-of-band", "return input.scope.fetch.data.items;"),
        actor_id: null,
      },
      ctx.db,
    );
    if ("errors" in updated) throw new Error(`update: ${updated.errors.join("; ")}`);

    const rows = await schedulesFor(wfId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(sched.id);
    expect(rows[0]?.cron).toBe("0 19 * * *");
    expect((rows[0]!.input as { recipient_email?: string })?.recipient_email).toBe("x@y.com");
  });

  test("removing an inline schedule trigger still unbinds (intended)", async () => {
    const created = await createWorkflow(
      { tenant_id, def: scheduledDef("sbse-remove-trigger", "0 8 * * *"), actor_id: null },
      ctx.db,
    );
    if ("errors" in created) throw new Error(`create: ${created.errors.join("; ")}`);
    const wfId = created.workflow.id;
    expect(await schedulesFor(wfId)).toHaveLength(1);

    // Trigger removed (schedule → request) IS a trigger-block change → the
    // reconcile must still run and tear the schedule down.
    const updated = await updateWorkflow(
      {
        tenant_id,
        id: wfId,
        def: requestDef("sbse-remove-trigger", "return input.scope.fetch.data.items;"),
        actor_id: null,
      },
      ctx.db,
    );
    if ("errors" in updated) throw new Error(`update: ${updated.errors.join("; ")}`);
    expect(await schedulesFor(wfId)).toHaveLength(0);
  });

  test("changing an inline trigger cron rebinds", async () => {
    const created = await createWorkflow(
      { tenant_id, def: scheduledDef("sbse-cron-change", "0 8 * * *"), actor_id: null },
      ctx.db,
    );
    if ("errors" in created) throw new Error(`create: ${created.errors.join("; ")}`);
    const wfId = created.workflow.id;

    const updated = await updateWorkflow(
      { tenant_id, id: wfId, def: scheduledDef("sbse-cron-change", "0 9 * * *"), actor_id: null },
      ctx.db,
    );
    if ("errors" in updated) throw new Error(`update: ${updated.errors.join("; ")}`);

    const rows = await schedulesFor(wfId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cron).toBe("0 9 * * *");
  });
});
