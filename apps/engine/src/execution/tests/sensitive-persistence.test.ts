import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, executionSteps, executions } from "../../db/schema/index.ts";
import { logRing } from "../../observability/log-ring.ts";
import { runExecution } from "../engine.ts";
import { recoverExecutionPayload } from "../sensitive-payload.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
const sensitive = "PRIVATE-SONG-CONTEXT-harmoniqs-recovery-canary";

beforeAll(async () => {
  ctx = await createEngineCtx("sensitive-persistence");
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

test("sensitive execution input and echoed output are absent from persisted previews and audit", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Sensitive persisted content",
    slug: "sensitive-persisted-content",
    execution_privacy: "sensitive",
    steps: [
      {
        id: "echo",
        kind: "transform",
        language: "javascript",
        expression: "return input.input;",
      },
    ],
  });
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: { songContext: sensitive },
    options: { hold_writes: true },
  });
  expect(result.status).toBe("succeeded");
  const execution = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, result.execution_id)));
  const steps = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, result.execution_id),
      ),
    );
  const audit = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenant_id, ctx.tenantId));
  expect(execution).toHaveLength(1);
  expect(steps).toHaveLength(1);
  expect(JSON.stringify({ execution, steps, audit })).not.toContain(sensitive);
  expect(recoverExecutionPayload(execution[0]?.input, ctx.tenantId, result.execution_id)).toEqual({
    songContext: sensitive,
  });
  expect(() =>
    recoverExecutionPayload(
      execution[0]?.input,
      "00000000-0000-4000-8000-000000000061",
      result.execution_id,
    ),
  ).toThrow();
  expect(() =>
    recoverExecutionPayload(
      execution[0]?.input,
      ctx.tenantId,
      "00000000-0000-4000-8000-000000000062",
    ),
  ).toThrow();
});

test("sensitive failures cannot copy user content into persisted errors or audit", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Sensitive failed content",
    slug: "sensitive-failed-content",
    execution_privacy: "sensitive",
    steps: [
      {
        id: "reject",
        kind: "transform",
        language: "javascript",
        expression: "throw new Error(input.input.songContext);",
      },
    ],
  });
  const logs: unknown[] = [];
  const unsubscribe = logRing.subscribe((entry) => logs.push(entry));
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: { songContext: sensitive },
    options: { hold_writes: true },
  }).finally(unsubscribe);
  expect(result.status).toBe("failed");
  const execution = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, result.execution_id)));
  const steps = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, result.execution_id),
      ),
    );
  const audit = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenant_id, ctx.tenantId));
  expect(execution).toHaveLength(1);
  expect(steps).toHaveLength(1);
  expect(JSON.stringify({ execution, steps, audit, logs })).not.toContain(sensitive);
});
