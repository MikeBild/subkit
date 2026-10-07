import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executions } from "../../db/schema/index.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { runExecution } from "../engine.ts";
import { createExecution } from "../state.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let workflowId: string;
let versionId: string;
let owner: ResolvedPrincipal;
beforeAll(async () => {
  ctx = await createEngineCtx("resume-owner-integrity");
  owner = {
    provider: "test",
    kind: "user",
    id: "00000000-0000-4000-8000-000000000097",
    tenant_id: ctx.tenantId,
    roles: ["admin"],
    product_id: "harmoniqs",
  };
  const workflow = await createWorkflowRow(ctx, {
    name: "Owner resume integrity",
    product_id: "harmoniqs",
    steps: [{ id: "read", kind: "transform", expression: "return input.scope.$caller;" }],
  });
  workflowId = workflow.workflow_id;
  versionId = workflow.version_id;
}, 30_000);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, 30_000);

async function queued() {
  return createExecution(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id: workflowId,
    workflow_version_id: versionId,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    input: { text: "private-original-input" },
    hold_writes: true,
    caller_context: callerFromPrincipal(owner, ctx.tenantId, "harmoniqs"),
  });
}
async function row(id: string) {
  return (
    await ctx.testDb.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, id)))
  )[0];
}

for (const rejection of [
  "foreign_owner",
  "foreign_product",
  "anonymous",
  "caller_only",
  "trusted_without_principal",
] as const) {
  test(`rejected ${rejection} resume leaves the owner's queued row untouched`, async () => {
    const id = await queued();
    const before = await row(id);
    const principal =
      rejection === "foreign_owner"
        ? { ...owner, id: "00000000-0000-4000-8000-000000000098" }
        : rejection === "foreign_product"
          ? { ...owner, product_id: "other" }
          : undefined;
    await expect(
      runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id: workflowId },
        input: before?.input,
        options: {
          existing_execution_id: id,
          ...(principal ? { principal } : {}),
          ...(rejection === "caller_only" || rejection === "trusted_without_principal"
            ? { caller_context: callerFromPrincipal(owner, ctx.tenantId, "harmoniqs") }
            : {}),
          ...(rejection === "trusted_without_principal" ? { resume_authorized: true } : {}),
        },
      }),
    ).rejects.toBeDefined();
    expect(await row(id)).toEqual(before);
  });
}

test("original authenticated owner can resume the admitted ordinary run", async () => {
  const id = await queued();
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflowId },
    input: { text: "private-original-input" },
    options: { existing_execution_id: id, principal: owner },
  });
  expect(result.status).toBe("succeeded");
  expect(result.output).toMatchObject({
    principalId: owner.id,
    principalKind: "user",
    productId: "harmoniqs",
  });
});
