import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { executionSteps, executions } from "../../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { protectExecutionPayload } from "../../../execution/sensitive-payload.ts";
import { createExecution } from "../../../execution/state.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../../../execution/tests/setup.ts";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import { hydrateBoundWorkflow, loadFocusExecution } from "../../draft.ts";
import { diagnoseLatestExecutionTool } from "../diagnose-latest-execution.ts";
import { getExecutionTool } from "../engine-api/executions.ts";
import type { ToolContext } from "../index.ts";
import { inspectExecutionTool } from "../inspect-execution.ts";
import { inspectExecutionStepTool } from "../inspect-execution-step.ts";
import { suggestJsonataPathsTool } from "../suggest-jsonata-paths.ts";

let ctx: EngineTestCtx;
let executionId: string;
let sensitiveExecutionId: string;
let workflowId: string;
let owner: ResolvedPrincipal;
const content = "private-owner-step-content";
const sensitiveContent = "sensitive-stale-step-content";

beforeAll(async () => {
  ctx = await createEngineCtx("conversation-execution-owner-read");
  owner = {
    tenant_id: ctx.tenantId,
    id: "00000000-0000-4000-8000-000000000081",
    kind: "user",
    provider: "test",
    product_id: "harmoniqs",
    roles: ["admin"],
  };
  const caller = {
    tenantId: ctx.tenantId,
    principalId: owner.id,
    principalKind: owner.kind,
    provider: owner.provider,
    productId: owner.product_id ?? null,
  };
  const workflow = await createWorkflowRow(ctx, {
    name: "Conversation owner read fixture",
    slug: "conversation-owner-read-fixture",
    product_id: "harmoniqs",
    steps: [{ id: "private", kind: "transform", expression: "return input.input;" }],
  });
  workflowId = workflow.workflow_id;
  const parameters = {
    tenant_id: ctx.tenantId,
    workflow_id: workflowId,
    workflow_version_id: workflow.version_id,
    source_kind: "saved" as const,
    source_ref: null,
    request_source: "api" as const,
    input: { text: content },
    caller_context: caller,
    hold_writes: true,
  };
  executionId = await createExecution(ctx.testDb.db, parameters);
  sensitiveExecutionId = await createExecution(ctx.testDb.db, {
    ...parameters,
    execution_privacy: "sensitive",
  });
  await ctx.testDb.db
    .update(executions)
    .set({ status: "succeeded" })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
  await ctx.testDb.db
    .update(executions)
    .set({
      status: "succeeded",
      sensitive_result: protectExecutionPayload(
        { text: content },
        ctx.tenantId,
        sensitiveExecutionId,
        "result",
      ),
    })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, sensitiveExecutionId)));
  await ctx.testDb.db.insert(executionSteps).values({
    tenant_id: ctx.tenantId,
    execution_id: executionId,
    step_key: "private",
    kind: "transform",
    status: "succeeded",
    output_preview: { text: content },
    finished_at: sql`clock_timestamp()`,
  });
  await ctx.testDb.db.insert(executionSteps).values({
    tenant_id: ctx.tenantId,
    execution_id: sensitiveExecutionId,
    step_key: "private",
    kind: "transform",
    status: "succeeded",
    output_preview: { text: sensitiveContent },
    finished_at: sql`clock_timestamp() + interval '1 hour'`,
  });
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

function toolContext(principal: ResolvedPrincipal): ToolContext {
  let draft = createEmptyDraftDocument();
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    conversation_id: "00000000-0000-4000-8000-000000000082",
    actor_id: principal.id,
    principal,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenantId,
      actor_id: principal.id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
}

for (const actorKind of ["another_owner", "generic_operator"] as const) {
  test(`step inspection denies a product owner's data to ${actorKind}`, async () => {
    const { product_id: _product, ...generic } = owner;
    const actor =
      actorKind === "another_owner"
        ? { ...owner, id: "00000000-0000-4000-8000-000000000083" }
        : generic;
    const result = await inspectExecutionStepTool.execute(toolContext(actor), {
      execution_id: executionId,
      step_key: "private",
      include_full_payload: true,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(content);
  });

  test(`execution diagnosis denies a product owner's data to ${actorKind}`, async () => {
    const { product_id: _product, ...generic } = owner;
    const actor =
      actorKind === "another_owner"
        ? { ...owner, id: "00000000-0000-4000-8000-000000000083" }
        : generic;
    const result = await inspectExecutionTool.execute(toolContext(actor), {
      execution_id: executionId,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(content);
  });

  test(`latest execution diagnosis denies a product owner's data to ${actorKind}`, async () => {
    const { product_id: _product, ...generic } = owner;
    const actor =
      actorKind === "another_owner"
        ? { ...owner, id: "00000000-0000-4000-8000-000000000083" }
        : generic;
    const result = await diagnoseLatestExecutionTool.execute(toolContext(actor), {
      execution_id: executionId,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(content);
  });

  test(`JSONata sample paths exclude another owner's preview for ${actorKind}`, async () => {
    const { product_id: _product, ...generic } = owner;
    const actor =
      actorKind === "another_owner"
        ? { ...owner, id: "00000000-0000-4000-8000-000000000083" }
        : generic;
    const toolCtx = toolContext(actor);
    toolCtx.workflow_id = workflowId;
    const result = await suggestJsonataPathsTool.execute(toolCtx, { step_id: "private" });
    expect(JSON.stringify(result)).not.toContain(content);
  });
}

test("the owner can inspect their product execution step", async () => {
  const result = await inspectExecutionStepTool.execute(toolContext(owner), {
    execution_id: executionId,
    step_key: "private",
  });
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).toContain(content);
});

test("conversation execution reads omit sensitive payload envelopes", async () => {
  const result = await getExecutionTool.execute(toolContext(owner), { id: sensitiveExecutionId });
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain(content);
  expect(JSON.stringify(result)).not.toContain("ciphertext");
  expect(JSON.stringify(result)).not.toContain("auth_tag");
});

test("step inspection refuses sensitive execution previews even for the owner", async () => {
  const result = await inspectExecutionStepTool.execute(toolContext(owner), {
    execution_id: sensitiveExecutionId,
    step_key: "private",
    include_full_payload: true,
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(sensitiveContent);
});

test("execution diagnosis refuses sensitive execution previews even for the owner", async () => {
  const result = await inspectExecutionTool.execute(toolContext(owner), {
    execution_id: sensitiveExecutionId,
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(sensitiveContent);
});

test("latest diagnosis refuses sensitive previews before writing the conversation draft", async () => {
  const toolCtx = toolContext(owner);
  const before = JSON.stringify(toolCtx.getDraft());
  const result = await diagnoseLatestExecutionTool.execute(toolCtx, {
    execution_id: sensitiveExecutionId,
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(sensitiveContent);
  expect(JSON.stringify(toolCtx.getDraft())).toBe(before);
});

test("JSONata sample paths cannot use the newest sensitive execution preview", async () => {
  const toolCtx = toolContext(owner);
  toolCtx.workflow_id = workflowId;
  const result = await suggestJsonataPathsTool.execute(toolCtx, { step_id: "private" });
  expect(JSON.stringify(result)).not.toContain(sensitiveContent);
});

test("opening a workflow draft cannot hydrate product execution content into a conversation", async () => {
  const draft = await hydrateBoundWorkflow(
    ctx.tenantId,
    workflowId,
    createEmptyDraftDocument(),
    ctx.testDb.db,
  );
  expect(JSON.stringify(draft)).not.toContain(content);
});

test("focused product executions require the original owner", async () => {
  const { product_id: _product, ...generic } = owner;
  for (const actor of [
    undefined,
    generic,
    { ...owner, id: "00000000-0000-4000-8000-000000000083" },
  ]) {
    expect(await loadFocusExecution(ctx.tenantId, executionId, ctx.testDb.db, actor)).toBeNull();
  }
});

test("the owner can focus their ordinary execution metadata", async () => {
  const result = await loadFocusExecution(ctx.tenantId, executionId, ctx.testDb.db, owner);
  expect(result).toMatchObject({ execution_id: executionId, diagnosis_available: true });
  expect(JSON.stringify(result)).not.toContain(content);
});

test("focusing a sensitive execution omits step diagnosis and warnings", async () => {
  const result = await loadFocusExecution(ctx.tenantId, sensitiveExecutionId, ctx.testDb.db, owner);
  expect(result).toMatchObject({
    execution_id: sensitiveExecutionId,
    diagnosis_available: false,
    warnings_count: 0,
  });
  expect(JSON.stringify(result)).not.toContain(sensitiveContent);
  expect(JSON.stringify(result)).not.toContain("ciphertext");
});
