import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { runExecution } from "../engine.ts";
import { admitWorkflowRun } from "../workflow-run-admission.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let workflowId: string;
let user: ResolvedPrincipal;

beforeAll(async () => {
  ctx = await createEngineCtx("caller-kind");
  user = {
    provider: "test",
    kind: "user",
    id: "00000000-0000-4000-8000-000000000032",
    tenant_id: ctx.tenantId,
    roles: ["enduser"],
    product_id: "harmoniqs",
  };
  const workflow = await createWorkflowRow(ctx, {
    name: "End user only",
    product_id: "harmoniqs",
    required_caller_kind: "user",
    steps: [{ id: "observe", kind: "transform", expression: "return input.scope.$caller;" }],
  });
  workflowId = workflow.workflow_id;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

test("admission refuses a machine sharing the user UUID before creating a run", async () => {
  await expect(
    admitWorkflowRun(
      {
        tenant_id: ctx.tenantId,
        workflow_id: workflowId,
        execution_environment: "dev",
        request_source: "api",
        hold_writes: true,
      },
      ctx.testDb.db,
      { ...user, kind: "system_account" },
    ),
  ).rejects.toMatchObject({ code: "caller_kind_mismatch" });
});

test("restored queue caller cannot cross a workflow kind boundary", async () => {
  await expect(
    runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflowId },
      input: null,
      options: {
        caller_context: callerFromPrincipal(
          { ...user, kind: "system_account" },
          ctx.tenantId,
          "harmoniqs",
        ),
        hold_writes: true,
      },
    }),
  ).rejects.toMatchObject({ code: "caller_kind_mismatch" });
});

test("matching user caller executes with its immutable identity", async () => {
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflowId },
    input: { principalKind: "system_account" },
    options: { principal: user, hold_writes: true },
  });
  expect(result.status).toBe("succeeded");
  expect(result.output).toMatchObject({ principalKind: "user", principalId: user.id });
});
