import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, executions } from "../../db/schema/index.ts";
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
  const [event] = await ctx.testDb.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.resource_id, result.execution_id),
        eq(auditLog.action, "execution.started"),
      ),
    );
  expect(event?.metadata).toMatchObject({
    runtime: {
      clock_ms: stepNow,
      evaluation_seed: result.execution_id,
      tools: {
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        packages: expect.arrayContaining([expect.objectContaining({ name: "@js-joda/timezone" })]),
      },
    },
  });
});

test("iteration identities distinguish UUIDs while retaining the execution clock", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "iteration-identities",
    steps: [
      { kind: "transform", id: "items", expression: "return [1,2,3];" },
      {
        kind: "transform",
        id: "stamp",
        for_each: "(scope) => scope.items.data",
        expression: "return { id: sk.uuid(), now: sk.now() };",
      },
      {
        kind: "transform",
        id: "collect",
        expression: "return input.scope.stamp.data.map(row => row.stamp.data);",
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
  const output = result.output as Array<{ id: string; now: number }>;
  expect(output).toHaveLength(3);
  expect(new Set(output.map((row) => row.id)).size).toBe(3);
  expect(new Set(output.map((row) => row.now)).size).toBe(1);
});
