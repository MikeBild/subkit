import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  executions,
  productIdentityTombstones,
  userIdentities,
  users,
} from "../../db/schema/index.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../../workflows/types.ts";
import { runExecution } from "../engine.ts";
import { callerBudgetFixtures, guardedDefinition } from "./caller-budget-fixtures.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

let roundWorkflow: string;

let roundDef: WorkflowDef;

const { admit, productUser, unit } = callerBudgetFixtures({
  get ctx() {
    return ctx;
  },
  get roundWorkflow() {
    return roundWorkflow;
  },
});

beforeAll(async () => {
  ctx = await createEngineCtx("caller-budget");
  roundDef = WorkflowDefSchema.parse(guardedDefinition(50));
  roundWorkflow = (await createWorkflowRow(ctx, roundDef)).workflow_id;
  await createWorkflowRow(ctx, guardedDefinition(3));
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe("caller erasure", () => {
  test("a successful erasure run removes the caller's product data and leaves a tombstone", async () => {
    const principal = await productUser();
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "delete account",
      product_id: "testapp",
      required_caller_kind: "user",
      execution_privacy: "sensitive",
      caller_erasure: "on_success",
      steps: [{ id: "noop", kind: "transform", expression: "return { deleted: true };" }],
    });
    await admit(principal, { turn_id: "before", round: 1 });
    const admitted = await admit(principal, {}, workflow_id);
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: admitted.input,
      options: { existing_execution_id: admitted.execution_id, principal, hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(await unit(principal, "before")).toBeUndefined();
    const identities = await ctx.testDb.db
      .select()
      .from(userIdentities)
      .where(
        and(eq(userIdentities.tenant_id, ctx.tenantId), eq(userIdentities.user_id, principal.id)),
      );
    expect(identities).toHaveLength(0);
    const [user] = await ctx.testDb.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, principal.id)));
    expect(user).toMatchObject({ status: "disabled", email: `erased:${principal.id}@invalid` });
    expect(user?.deleted_at).not.toBeNull();
    const tombstones = await ctx.testDb.db
      .select()
      .from(productIdentityTombstones)
      .where(eq(productIdentityTombstones.tenant_id, ctx.tenantId));
    expect(tombstones.some((row) => row.subject_sha256.length === 64)).toBe(true);
    expect(JSON.stringify(tombstones)).not.toContain(principal.subject ?? "-");
    const [execution] = await ctx.testDb.db
      .select({ caller_context: executions.caller_context })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, admitted.execution_id)));
    expect(execution?.caller_context?.subject).toBeNull();
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, principal.id)));
    expect(audits.some((row) => row.action === "user.deleted")).toBe(true);
  });

  test("a failed erasure run changes nothing", async () => {
    const principal = await productUser();
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "delete account failing",
      product_id: "testapp",
      required_caller_kind: "user",
      execution_privacy: "sensitive",
      caller_erasure: "on_success",
      steps: [{ id: "boom", kind: "transform", expression: "throw new Error('apple refused');" }],
    });
    const admitted = await admit(principal, {}, workflow_id);
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: admitted.input,
      options: { existing_execution_id: admitted.execution_id, principal, hold_writes: true },
    });
    expect(result.status).toBe("failed");
    const [user] = await ctx.testDb.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, principal.id)));
    expect(user?.status).toBe("active");
  });
});

describe("caller erasure robustness", () => {
  async function erasureWorkflow(slug: string) {
    return (
      await createWorkflowRow(ctx, {
        name: slug,
        slug,
        product_id: "testapp",
        required_caller_kind: "user",
        execution_privacy: "sensitive",
        caller_erasure: "on_success",
        steps: [{ id: "noop", kind: "transform", expression: "return { deleted: true };" }],
      })
    ).workflow_id;
  }

  test("an erasure run without a verified subject is refused at admission", async () => {
    const principal = await productUser();
    const workflow_id = await erasureWorkflow("erasure-needs-subject");
    const { subject: _subject, ...withoutSubject } = principal;
    await expect(admit(withoutSubject, {}, workflow_id)).rejects.toMatchObject({
      code: "caller_required",
    });
  });

  test("an erasure still finishes when the identity binding is already gone", async () => {
    const principal = await productUser();
    const workflow_id = await erasureWorkflow("erasure-without-binding");
    const admitted = await admit(principal, {}, workflow_id);
    await ctx.testDb.db
      .delete(userIdentities)
      .where(
        and(eq(userIdentities.tenant_id, ctx.tenantId), eq(userIdentities.user_id, principal.id)),
      );
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: admitted.input,
      options: { existing_execution_id: admitted.execution_id, principal, hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    const [row] = await ctx.testDb.db
      .select({ status: executions.status })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, admitted.execution_id)));
    expect(row?.status).toBe("succeeded");
    const [user] = await ctx.testDb.db
      .select({ status: users.status })
      .from(users)
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, principal.id)));
    expect(user?.status).toBe("disabled");
  });
});
