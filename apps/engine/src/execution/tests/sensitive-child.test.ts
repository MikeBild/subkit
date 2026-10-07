import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import { isSensitivePayload } from "../sensitive-payload.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let sensitiveChild: string;
const secret = "SENSITIVE-CHILD-OUTPUT-CANARY";

beforeAll(async () => {
  ctx = await createEngineCtx("sensitive-child");
  const child = await createWorkflowRow(ctx, {
    name: "Sensitive child",
    slug: "sensitive-child",
    execution_privacy: "sensitive",
    steps: [
      {
        id: "secret",
        kind: "transform",
        language: "javascript",
        expression: `return "${secret}";`,
      },
    ],
  });
  sensitiveChild = child.workflow_id;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

for (const requestSource of ["api", "chat"] as const) {
  test(`ordinary ${requestSource} parent refuses sensitive child before child persistence`, async () => {
    const parent = await createWorkflowRow(ctx, {
      name: `Ordinary ${requestSource} parent`,
      slug: `ordinary-${requestSource}-parent`,
      steps: [{ id: "child", kind: "call", workflow_id: sensitiveChild }],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: null,
      options: { hold_writes: true, request_source: requestSource },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("sensitive_execution_unsupported");
    const children = await ctx.testDb.db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenantId),
          eq(executions.parent_execution_id, result.execution_id),
        ),
      );
    expect(children).toHaveLength(0);
    const steps = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenantId),
          eq(executionSteps.execution_id, result.execution_id),
        ),
      );
    expect(JSON.stringify({ result, steps })).not.toContain(secret);
  });
}

test("sensitive parent can call sensitive child while both persistence boundaries stay encrypted", async () => {
  const parent = await createWorkflowRow(ctx, {
    name: "Sensitive parent",
    slug: "sensitive-parent",
    execution_privacy: "sensitive",
    steps: [{ id: "child", kind: "call", workflow_id: sensitiveChild }],
  });
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: parent.workflow_id },
    input: null,
    options: { hold_writes: true },
  });
  expect(result.status).toBe("succeeded");
  expect(JSON.stringify(result.output)).toContain(secret);
  const rows = await ctx.testDb.db
    .select()
    .from(executions)
    .where(
      and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, parent.workflow_id)),
    );
  const children = await ctx.testDb.db
    .select()
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, ctx.tenantId),
        eq(executions.parent_execution_id, result.execution_id),
      ),
    );
  expect(children).toHaveLength(1);
  expect(rows.every((row) => isSensitivePayload(row.input))).toBe(true);
  expect(children.every((row) => isSensitivePayload(row.input))).toBe(true);
  expect(JSON.stringify({ rows, children })).not.toContain(secret);
});
