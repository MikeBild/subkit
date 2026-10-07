import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { executionSteps, executions } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createEmptyDraftDocument, withWorkflowDraft } from "../../authoring-state.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import { __resetDryRunCacheForTest } from "../dry-run-cache.ts";
import { dryRunWorkflowTool } from "../dry-run-workflow.ts";
import type { ToolContext } from "../index.ts";

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-caller");
});
afterAll(async () => {
  __resetDryRunCacheForTest();
  await ctx.cleanup();
});

function toolContext(
  principal: ResolvedPrincipal,
  productBound = false,
  sensitive = false,
): ToolContext {
  let draft = withWorkflowDraft(createEmptyDraftDocument("workflow_authoring"), {
    name: "Observe preview caller",
    steps: [{ id: "observe", kind: "transform", expression: "return input.scope.$caller;" }],
    ...(productBound ? { product_id: "harmoniqs", required_caller_kind: "user" } : {}),
    ...(sensitive ? { execution_privacy: "sensitive" } : {}),
  });
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: "00000000-0000-4000-8000-000000000036",
    actor_id: principal.id,
    principal,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: principal.id,
      actor_type: principal.kind,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
}

function user(): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  };
}

test("same draft and input cannot reuse another principal kind's preview or step fixture", async () => {
  __resetDryRunCacheForTest();
  const first = await dryRunWorkflowTool.execute(toolContext(user()), { input: {} });
  const second = await dryRunWorkflowTool.execute(
    toolContext({ ...user(), kind: "system_account" }),
    { input: {} },
  );
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  const rows = await ctx.testDb.db
    .select()
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenant_id));
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.caller_context?.principalKind))).toEqual(
    new Set(["user", "system_account"]),
  );
  const steps = await ctx.testDb.db
    .select({ output: executionSteps.output_preview })
    .from(executionSteps)
    .where(eq(executionSteps.tenant_id, ctx.tenant_id));
  expect(
    new Set(steps.map((step) => (step.output as { principalKind?: string })?.principalKind)),
  ).toEqual(new Set(["user", "system_account"]));
});

test("product caller draft preview refuses before execution or persistent preview writes", async () => {
  const principal = { ...user(), product_id: "harmoniqs" };
  const context = toolContext(principal, true);
  const initialDraft = JSON.stringify(context.getDraft());
  let writes = 0;
  context.setDraft = async () => {
    writes++;
  };
  const before = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenant_id));
  const result = await dryRunWorkflowTool.execute(context, {
    input: { secret: "preview-canary" },
  });
  expect(result).toMatchObject({ ok: false, error_code: "caller_saved_workflow_required" });
  expect(JSON.stringify(result)).not.toContain("preview-canary");
  expect(writes).toBe(0);
  expect(JSON.stringify(context.getDraft())).toBe(initialDraft);
  const after = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenant_id));
  expect(after).toEqual(before);
});

test("sensitive preview refuses before execution, cache or persistent draft writes", async () => {
  const context = toolContext({ ...user(), product_id: "harmoniqs" }, true, true);
  const initialDraft = JSON.stringify(context.getDraft());
  let writes = 0;
  context.setDraft = async () => {
    writes++;
  };
  const before = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenant_id));
  const result = await dryRunWorkflowTool.execute(context, { input: { secret: "preview-canary" } });
  expect(result).toMatchObject({ ok: false, error_code: "sensitive_execution_unsupported" });
  expect(JSON.stringify(result)).not.toContain("preview-canary");
  expect(writes).toBe(0);
  expect(JSON.stringify(context.getDraft())).toBe(initialDraft);
  const after = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenant_id));
  expect(after).toEqual(before);
});
