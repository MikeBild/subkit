import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executions, users, workflows, workflowVersions } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { bindExistingRun } from "../bound-run.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { runExecution } from "../engine.ts";
import { recoverExecutionPayload } from "../sensitive-payload.ts";
import { createExecution } from "../state.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let owner: ResolvedPrincipal;
let stranger: ResolvedPrincipal;
const input = { songContext: "PRIVATE-RECOVERY-CONTENT" };

beforeAll(async () => {
  ctx = await createEngineCtx("sensitive-recovery");
  const role = await builtinRoleId(ctx.testDb.db, "member");
  const people = await ctx.testDb.db
    .insert(users)
    .values([
      { tenant_id: ctx.tenantId, email: "owner@example.test", role_id: role },
      { tenant_id: ctx.tenantId, email: "stranger@example.test", role_id: role },
    ])
    .returning();
  const first = people[0];
  const second = people[1];
  if (!first || !second) throw new Error("missing people fixtures");
  owner = {
    provider: "test",
    kind: "user",
    id: first.id,
    tenant_id: ctx.tenantId,
    product_id: "harmoniqs",
    roles: ["member"],
  };
  stranger = { ...owner, id: second.id };
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

async function queued(label: string) {
  const workflow = await createWorkflowRow(ctx, {
    name: label,
    slug: label,
    product_id: "harmoniqs",
    execution_privacy: "sensitive",
    steps: [
      { id: "echo", kind: "transform", language: "javascript", expression: "return input.input;" },
    ],
  });
  const id = await createExecution(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    input,
    caller_context: callerFromPrincipal(owner, ctx.tenantId, "harmoniqs"),
    hold_writes: true,
  });
  const [row] = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, id)));
  if (!row) throw new Error("missing execution fixture");
  return { row, workflow };
}

test("owner resume recovers encrypted input and final result with authenticated bindings", async () => {
  const { row, workflow } = await queued("sensitive-owner-resume");
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflow.workflow_id },
    input: row.input,
    options: { existing_execution_id: row.id, principal: owner },
  });
  expect(result.status).toBe("succeeded");
  expect(result.output).toEqual(input);
  const [finished] = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, row.id)));
  expect(JSON.stringify(finished)).not.toContain(input.songContext);
  expect(
    recoverExecutionPayload(finished?.sensitive_result, ctx.tenantId, row.id, "result"),
  ).toEqual(input);
});

test("a different authenticated caller cannot decrypt or bind another owner's resume", async () => {
  const { row, workflow } = await queued("sensitive-stranger-resume");
  await expect(
    bindExistingRun(
      ctx.testDb.db,
      ctx.tenantId,
      { kind: "saved", workflow_id: workflow.workflow_id },
      row.input,
      { existing_execution_id: row.id, principal: stranger },
    ),
  ).rejects.toThrow("execution boundary");
});

test("sensitive resume requires authentication even when the input ciphertext is known", async () => {
  const { row, workflow } = await queued("sensitive-anonymous-resume");
  await expect(
    bindExistingRun(
      ctx.testDb.db,
      ctx.tenantId,
      { kind: "saved", workflow_id: workflow.workflow_id },
      row.input,
      { existing_execution_id: row.id },
    ),
  ).rejects.toThrow("original authenticated caller");
});

test("internal queue resume refuses a disabled principal before recovery", async () => {
  const { row, workflow } = await queued("sensitive-disabled-resume");
  await ctx.testDb.db
    .update(users)
    .set({ status: "disabled" })
    .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, owner.id)));
  try {
    await expect(
      bindExistingRun(
        ctx.testDb.db,
        ctx.tenantId,
        { kind: "saved", workflow_id: workflow.workflow_id },
        row.input,
        { existing_execution_id: row.id, resume_authorized: true, principal: owner },
      ),
    ).rejects.toThrow("no longer active");
  } finally {
    await ctx.testDb.db
      .update(users)
      .set({ status: "active" })
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, owner.id)));
  }
});

test("resume keeps the persisted workflow version's privacy after activation changes", async () => {
  const original = {
    name: "Persisted privacy",
    slug: "persisted-privacy",
    product_id: "harmoniqs",
    steps: [
      { id: "echo", kind: "transform", language: "javascript", expression: "return input.input;" },
    ],
  } as const;
  const workflow = await createWorkflowRow(ctx, original);
  const executionId = await createExecution(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    input,
    caller_context: callerFromPrincipal(owner, ctx.tenantId, "harmoniqs"),
    hold_writes: true,
  });
  const [activated] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflow.workflow_id,
      version: 2,
      dag: { ...original, execution_privacy: "sensitive" },
    })
    .returning();
  if (!activated) throw new Error("missing activated version");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: activated.id })
    .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, workflow.workflow_id)));

  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflow.workflow_id },
    input,
    options: { existing_execution_id: executionId, principal: owner },
  });
  expect(result.status).toBe("succeeded");
  expect(result.steps[0]?.output_preview).not.toBeNull();
  const [finished] = await ctx.testDb.db
    .select({ sensitive_result: executions.sensitive_result })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
  expect(finished?.sensitive_result).toBeNull();
});

test("sensitive output is refused before a conversation run persists an execution", async () => {
  const workflow = await createWorkflowRow(ctx, {
    name: "Sensitive conversation boundary",
    slug: "sensitive-conversation-boundary",
    product_id: "harmoniqs",
    execution_privacy: "sensitive",
    steps: [
      { id: "echo", kind: "transform", language: "javascript", expression: "return input.input;" },
    ],
  });
  await expect(
    runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflow.workflow_id },
      input,
      options: { principal: owner, request_source: "chat" },
    }),
  ).rejects.toMatchObject({ code: "sensitive_execution_unsupported" });
  const rows = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflow.workflow_id)),
    );
  expect(rows).toHaveLength(0);
});
