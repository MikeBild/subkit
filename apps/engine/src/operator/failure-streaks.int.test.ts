import { afterAll, beforeAll, expect, test } from "bun:test";
import { executions, tenants, workflows } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { readFailureStreaks } from "./failure-streaks.ts";

const nextId = createDeterministicUuidFactory(0x571ea);
const tenantId = nextId();
const otherTenant = nextId();
const workflowId = nextId();
const otherWorkflow = nextId();
let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("failure_streaks");
  await ctx.db.insert(tenants).values([
    { id: tenantId, slug: "streak", display_name: "Streak" },
    { id: otherTenant, slug: "other-streak", display_name: "Other" },
  ]);
  await ctx.db.insert(workflows).values([
    { id: workflowId, tenant_id: tenantId, slug: "streak", name: "Streak", lifecycle: "active" },
    {
      id: otherWorkflow,
      tenant_id: otherTenant,
      slug: "other",
      name: "Other",
      lifecycle: "active",
    },
  ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

async function terminal(
  status: typeof executions.$inferInsert.status,
  offset: number,
  tenant = tenantId,
  workflow = workflowId,
) {
  await ctx.db.insert(executions).values({
    id: nextId(),
    tenant_id: tenant,
    workflow_id: workflow,
    status,
    request_source: "scheduler",
    execution_mode: "prod",
    created_at: new Date(FROZEN_NOW + offset),
    finished_at: status === "running" ? null : new Date(FROZEN_NOW + offset),
  });
}

test("counts only the current completed failure sequence with tenant and time isolation", async () => {
  await terminal("failed", -6000);
  await terminal("succeeded", -5000);
  await terminal("failed", -4000);
  await terminal("failed", -3000);
  await terminal("running", -2000);
  await terminal("failed", 1000);
  await terminal("failed", -1000, otherTenant, otherWorkflow);
  const at = new Date(FROZEN_NOW);
  expect(await readFailureStreaks(ctx.db, tenantId, [], at)).toEqual(new Map());
  expect(await readFailureStreaks(ctx.db, tenantId, [workflowId, otherWorkflow], at)).toEqual(
    new Map([[workflowId, 2]]),
  );
  await terminal("aborted", -1000);
  expect(await readFailureStreaks(ctx.db, tenantId, [workflowId], at)).toEqual(new Map());
  await terminal("failed", -800);
  expect((await readFailureStreaks(ctx.db, tenantId, [workflowId], at)).get(workflowId)).toBe(1);
  await terminal("timed_out", -500);
  expect(await readFailureStreaks(ctx.db, tenantId, [workflowId], at)).toEqual(new Map());
});
