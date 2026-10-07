import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  executions,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { workflowPreparationInput } from "../../workflows/preparation-input.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { bindExistingRun } from "../bound-run.ts";
import { runExecution } from "../engine.ts";
import { createExecution } from "../state.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
beforeAll(async () => {
  ctx = await createEngineCtx("input-compatibility");
}, 30_000);
afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

for (const fixture of [
  {
    name: "optional-object",
    schema: { type: "object" },
    input: undefined,
    expected: {},
    status: "succeeded",
  },
  { name: "no-schema", schema: undefined, input: undefined, expected: null, status: "succeeded" },
  {
    name: "explicit-null",
    schema: { type: "object" },
    input: null,
    expected: null,
    status: "failed",
  },
  {
    name: "required-object",
    schema: { type: "object", required: ["value"] },
    input: undefined,
    expected: {},
    status: "failed",
  },
] as const) {
  test(`child ${fixture.name} preserves omission and explicit input semantics`, async () => {
    const child = await createWorkflowRow(ctx, {
      name: fixture.name,
      slug: `child-${fixture.name}`,
      ...(fixture.schema ? { input_schema: fixture.schema } : {}),
      steps: [
        {
          kind: "transform",
          id: "echo",
          language: "javascript",
          expression: "return input.scope.$input;",
        },
      ],
    });
    const parent = await createWorkflowRow(ctx, {
      name: fixture.name,
      slug: `parent-${fixture.name}`,
      steps: [
        {
          kind: "call",
          id: "child",
          workflow_id: child.workflow_id,
          ...(fixture.input === undefined ? {} : { input: fixture.input }),
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: undefined,
    });
    expect(result.status).toBe(fixture.status);
    const [row] = await ctx.testDb.db
      .select()
      .from(executions)
      .where(
        and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, child.workflow_id)),
      );
    if (fixture.status === "succeeded") expect(row?.input).toEqual(fixture.expected);
  });
}

test("authority replay normalizes against its pinned object schema after the active schema changes", async () => {
  const definition = {
    name: "pinned-input",
    slug: "pinned-input",
    input_schema: { type: "object" },
    steps: [
      {
        kind: "transform",
        id: "echo",
        language: "javascript",
        expression: "return input.scope.$input;",
      },
    ],
  };
  const saved = await createWorkflowRow(ctx, definition);
  const [authority] = await ctx.testDb.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: saved.workflow_id,
      workflow_version_id: saved.version_id,
      effect_manifest_digest: "a".repeat(64),
      effect_manifest: {},
      target_constraints: { targets: [] },
      execution_environment: "dev",
      created_by: ctx.tenantId,
    })
    .returning();
  if (!authority) throw new Error("authority fixture missing");
  const executionId = await createExecution(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id: saved.workflow_id,
    workflow_version_id: saved.version_id,
    execution_authority_id: authority.id,
    source_kind: "saved",
    source_ref: null,
    caller_context: null,
    request_source: "api",
    execution_mode: "dev",
    input: {},
    idempotency_key: "pinned-object",
  });
  const [next] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: saved.workflow_id,
      version: 2,
      dag: { ...definition, input_schema: { type: "array" } },
    })
    .returning();
  if (!next) throw new Error("next version missing");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: next.id })
    .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, saved.workflow_id)));
  const params = {
    tenant_id: ctx.tenantId,
    workflow_id: saved.workflow_id,
    execution_environment: "dev",
    request_source: "api",
    idempotency_key: "pinned-object",
  };
  const replay = await admitAuthorizedWorkflowExecution(params, ctx.testDb.db);
  expect(replay).toMatchObject({
    execution_id: executionId,
    workflow_version_id: saved.version_id,
    input: {},
    replayed: true,
  });
  await expect(
    admitAuthorizedWorkflowExecution({ ...params, input: null }, ctx.testDb.db),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  const heldExecutionId = await createExecution(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id: saved.workflow_id,
    workflow_version_id: saved.version_id,
    source_kind: "saved",
    source_ref: null,
    caller_context: null,
    request_source: "api",
    execution_mode: "dev",
    input: {},
    hold_writes: true,
  });
  const bound = await bindExistingRun(
    ctx.testDb.db,
    ctx.tenantId,
    { kind: "saved", workflow_id: saved.workflow_id },
    undefined,
    { existing_execution_id: heldExecutionId },
  );
  expect(bound.input).toEqual({});
  expect(bound.source).toMatchObject({ version_id: saved.version_id });
  const historicalNullId = await createExecution(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id: saved.workflow_id,
    workflow_version_id: saved.version_id,
    source_kind: "saved",
    source_ref: null,
    caller_context: null,
    request_source: "api",
    execution_mode: "dev",
    input: null,
    hold_writes: true,
  });
  await expect(
    bindExistingRun(
      ctx.testDb.db,
      ctx.tenantId,
      { kind: "saved", workflow_id: saved.workflow_id },
      undefined,
      { existing_execution_id: historicalNullId },
    ),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  const historical = await bindExistingRun(
    ctx.testDb.db,
    ctx.tenantId,
    { kind: "saved", workflow_id: saved.workflow_id },
    null,
    { existing_execution_id: historicalNullId },
  );
  expect(historical.input).toBeNull();
});

test("preparation omission does not invent an input without a matching schedule", async () => {
  const saved = await createWorkflowRow(ctx, {
    name: "unscheduled-input",
    slug: "unscheduled-input",
    steps: [{ kind: "transform", id: "echo", expression: "$input" }],
  });
  expect(
    await workflowPreparationInput(ctx.testDb.db, ctx.tenantId, saved.workflow_id, "dev", {
      execute_writes: false,
    }),
  ).toBeUndefined();
  expect(
    await workflowPreparationInput(ctx.testDb.db, ctx.tenantId, saved.workflow_id, "dev", {
      execute_writes: false,
      input: {},
    }),
  ).toEqual({});
});
