import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuthProviderRegistry } from "../../auth/registry.ts";
import { auditLog, executions } from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { admissionRefusal } from "../routes/executions/admission-errors.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let workflowId: string;
beforeAll(async () => {
  const registry = new AuthProviderRegistry().register({
    name: "test",
    capabilities: { human: true, machine: true, interactive: false, refresh: false, revoke: false },
    async resolve(request) {
      const mode = request.headers.get("authorization");
      if (!mode) return null;
      return {
        provider: "test",
        kind: mode === "Bearer machine" ? "system_account" : "user",
        id: mode === "Bearer machine" ? ctx.systemAccountId : ctx.userId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
        ...(mode === "Bearer generic"
          ? {}
          : { product_id: mode === "Bearer other" ? "other" : "harmoniqs" }),
      };
    },
  });
  ctx = await createHttpTestServer("execution-caller-admission", { appOptions: { registry } });
  const workflow = await createWorkflowRow(ctx, {
    name: "Product user admission",
    product_id: "harmoniqs",
    required_caller_kind: "user",
    steps: [{ id: "echo", kind: "transform", expression: "return input.input;" }],
  });
  workflowId = workflow.workflow_id;
}, 30_000);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, 30_000);

for (const mode of ["generic", "other", "machine"]) {
  test(`saved run refuses ${mode} caller with an audited policy response`, async () => {
    const code = mode === "machine" ? "caller_kind_mismatch" : "caller_product_mismatch";
    const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
      method: "POST",
      headers: { authorization: `Bearer ${mode}`, "content-type": "application/json" },
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    const denied = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, workflowId),
          eq(auditLog.reason, code),
        ),
      );
    expect(denied.length).toBeGreaterThan(0);
    for (const entry of denied) {
      expect(entry).toMatchObject({
        actor_type: mode === "machine" ? "system_account" : "user",
        actor_id: mode === "machine" ? ctx.systemAccountId : ctx.userId,
      });
    }
    const rows = await ctx.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflowId)));
    expect(rows).toHaveLength(0);
  });
}

for (const code of [
  "caller_required",
  "caller_tenant_mismatch",
  "sensitive_resume_forbidden",
  "sensitive_execution_unsupported",
]) {
  test(`domain refusal ${code} retains its audited HTTP status`, async () => {
    await expect(
      admissionRefusal(Object.assign(new Error(code), { code }), {
        db: ctx.db,
        principal: {
          provider: "test",
          kind: "user",
          id: ctx.userId,
          tenant_id: ctx.tenantId,
          roles: ["admin"],
        },
        workflow_id: workflowId,
        request_source: "api",
      }),
    ).rejects.toMatchObject({
      status: code === "sensitive_execution_unsupported" ? 409 : 403,
      code,
    });
    const denied = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, workflowId),
          eq(auditLog.reason, code),
        ),
      );
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ actor_type: "user", actor_id: ctx.userId });
    expect(
      await ctx.db
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflowId))),
    ).toHaveLength(0);
  });
}

test("an explicitly selected unavailable version returns an audited conflict", async () => {
  const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({
      source: "saved",
      workflow_id: workflowId,
      version_id: "00000000-0000-4000-8000-000000000099",
      input: {},
    }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "workflow_version_unavailable" });
  const denied = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.resource_id, workflowId),
        eq(auditLog.reason, "workflow_version_unavailable"),
      ),
    );
  expect(denied).toHaveLength(1);
  expect(denied[0]).toMatchObject({ actor_type: "user", actor_id: ctx.userId });
  expect(
    await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflowId))),
  ).toHaveLength(0);
});

test("unknown internal errors retain their original identity", async () => {
  const error = new Error("internal database failure");
  await expect(
    admissionRefusal(error, {
      db: ctx.db,
      principal: {
        provider: "test",
        kind: "user",
        id: ctx.userId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
      },
      workflow_id: workflowId,
      request_source: "api",
    }),
  ).rejects.toBe(error);
});
