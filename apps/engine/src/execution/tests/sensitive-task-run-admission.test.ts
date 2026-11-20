import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { admitWorkflowRun } from "../workflow-run-admission.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let sensitiveId: string;
let plainId: string;
let person: ResolvedPrincipal;

const taskRunSource = {
  kind: "task_run" as const,
  task_id: "55555555-5555-4555-8555-555555555555",
  task_run_id: "66666666-6666-4666-8666-666666666666",
  grant_id: null,
};

function admit(workflow_id: string, request_source: string, principal: ResolvedPrincipal) {
  return admitWorkflowRun(
    {
      tenant_id: ctx.tenantId,
      workflow_id,
      execution_environment: "dev",
      request_source,
      hold_writes: true,
    },
    ctx.testDb.db,
    principal,
  );
}

async function refusalCode(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

beforeAll(async () => {
  ctx = await createEngineCtx("sensitive-task-run");
  person = {
    provider: "test",
    kind: "user",
    id: "00000000-0000-4000-8000-000000000041",
    tenant_id: ctx.tenantId,
    roles: ["member"],
  };
  const steps = [{ id: "observe", kind: "transform", expression: "return 1;" }];
  sensitiveId = (
    await createWorkflowRow(ctx, { name: "Sensitive", execution_privacy: "sensitive", steps })
  ).workflow_id;
  plainId = (await createWorkflowRow(ctx, { name: "Plain", steps })).workflow_id;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

test("a task run cannot start a sensitive workflow from a background source", async () => {
  for (const source of ["queue", "scheduler", "api", "mcp"]) {
    expect(await refusalCode(admit(sensitiveId, source, { ...person, provider: "task" }))).toBe(
      "sensitive_execution_unsupported",
    );
    expect(
      await refusalCode(admit(sensitiveId, source, { ...person, auth_source: taskRunSource })),
    ).toBe("sensitive_execution_unsupported");
  }
});

test("the refusal follows the task principal, not the source", async () => {
  for (const source of ["queue", "scheduler"]) {
    expect(await refusalCode(admit(sensitiveId, source, person))).not.toBe(
      "sensitive_execution_unsupported",
    );
    expect(
      await refusalCode(
        admit(plainId, source, { ...person, provider: "task", auth_source: taskRunSource }),
      ),
    ).not.toBe("sensitive_execution_unsupported");
  }
});
