import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { events, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { emitResourceChange, RESOURCE_CHANGE_TYPES } from "../resource-changes.ts";

const TASK_ID = "44444444-5555-4666-8777-888888888888";
const RUN_ID = "55555555-6666-4777-8888-999999999999";
const GRANT_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("resource_changes_tasks");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-resource-changes-tasks", display_name: "Resource changes" })
    .returning();
  if (!tenant) throw new Error("tenant fixture missing");
  tenant_id = tenant.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

test("the task change types are part of the closed resource change list", () => {
  expect(RESOURCE_CHANGE_TYPES.filter((type) => type.startsWith("task"))).toEqual([
    "task.changed",
    "task.grant_changed",
    "task_run.changed",
  ]);
  expect(new Set(RESOURCE_CHANGE_TYPES).size).toBe(RESOURCE_CHANGE_TYPES.length);
});

test("task changes announce themselves with their ids only", async () => {
  await ctx.db.transaction(async (tx) => {
    await emitResourceChange(tx, { tenant_id, type: "task.changed", ids: { task_id: TASK_ID } });
    await emitResourceChange(tx, {
      tenant_id,
      type: "task.grant_changed",
      ids: { task_id: TASK_ID, task_grant_id: GRANT_ID, task_run_id: null },
    });
    await emitResourceChange(tx, {
      tenant_id,
      type: "task_run.changed",
      ids: { task_id: TASK_ID, task_run_id: RUN_ID, task_grant_id: "" },
    });
  });
  const rows = await ctx.db
    .select({ type: events.type, payload: events.payload })
    .from(events)
    .where(and(eq(events.tenant_id, tenant_id), eq(events.channel, "resource.lifecycle")))
    .orderBy(asc(events.id));
  expect(rows).toEqual([
    { type: "task.changed", payload: { task_id: TASK_ID } },
    { type: "task.grant_changed", payload: { task_id: TASK_ID, task_grant_id: GRANT_ID } },
    { type: "task_run.changed", payload: { task_id: TASK_ID, task_run_id: RUN_ID } },
  ]);
});
