import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("exec-clock");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("sk.now() in a transform equals the persisted execution started_at", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "exec-clock-wf",
    steps: [
      {
        kind: "transform",
        id: "stamp",
        language: "javascript",
        expression: "return { step_now: sk.now() };",
      },
    ],
  });

  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: {},
  });

  expect(result.status).toBe("succeeded");
  const stepNow = (result.output as { step_now: number }).step_now;
  expect(typeof stepNow).toBe("number");
  expect(stepNow).toBeGreaterThan(0);

  const [row] = await ctx.testDb.db
    .select({ started_at: executions.started_at })
    .from(executions)
    .where(eq(executions.workflow_id, workflow_id));
  expect(row?.started_at).not.toBeNull();
  expect(stepNow).toBe(row!.started_at!.getTime());
});
