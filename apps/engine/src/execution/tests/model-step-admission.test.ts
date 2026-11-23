import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executions, workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitWorkflowRun } from "../workflow-run-admission.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("model-step-admission");
});

afterAll(async () => {
  await ctx?.cleanup();
});

const modelOnly = [
  {
    id: "classify",
    kind: "model",
    prompt: "Sort ${input.text}",
    output_schema: { type: "object" },
  },
];

async function runs(workflow_id: string) {
  return ctx.testDb.db
    .select({ id: executions.id, authority: executions.execution_authority_id })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflow_id)));
}

function admit(workflow_id: string, hold_writes?: boolean) {
  return admitWorkflowRun(
    {
      tenant_id: ctx.tenantId,
      workflow_id,
      execution_environment: "dev",
      request_source: "api",
      input: { text: "I was charged twice" },
      ...(hold_writes !== undefined ? { hold_writes } : {}),
    },
    ctx.testDb.db,
  );
}

test("a model-only workflow without an approval does not run, not even as a held preparation", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, { name: "model only", steps: modelOnly });
  await expect(admit(workflow_id)).rejects.toMatchObject({
    code: "execution_authority_required",
  });
  await expect(admit(workflow_id, true)).rejects.toMatchObject({
    code: "execution_authority_required",
  });
  expect(await runs(workflow_id)).toEqual([]);
});

test("a workflow without model steps still falls back to a held preparation", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "transform only",
    steps: [{ id: "shape", kind: "transform", language: "javascript", expression: "return 1;" }],
  });
  const held = await admit(workflow_id, true);
  expect(held).toMatchObject({ hold_writes: true, execution_authority_id: null });
});

test("an approved model-only workflow runs under its authority", async () => {
  const { workflow_id, version_id } = await createWorkflowRow(ctx, {
    name: "model approved",
    steps: modelOnly,
  });
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      execution_environment: "dev",
    },
    ctx.testDb.db,
  );
  expect(preview.manifest.model_calls?.map((call) => call.step_id)).toEqual(["classify"]);
  const at = await databaseNow(ctx.testDb.db);
  const [authority] = await ctx.testDb.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      target_constraints: { targets: [] },
      execution_environment: "dev",
      valid_from: new Date(at.getTime() - 60_000),
      created_by: "00000000-0000-4000-8000-000000000001",
    })
    .returning();
  const admitted = await admit(workflow_id);
  expect(admitted).toMatchObject({ hold_writes: false, execution_authority_id: authority?.id });
  expect(await runs(workflow_id)).toEqual([
    { id: admitted.execution_id, authority: authority?.id ?? null },
  ]);
});
