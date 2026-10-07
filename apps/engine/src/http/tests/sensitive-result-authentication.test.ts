import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, executions } from "../../db/schema/index.ts";
import { protectExecutionPayload } from "../../execution/sensitive-payload.ts";
import { createExecution } from "../../execution/state.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let executionId: string;
const secret = "SENSITIVE-AUTH-PROVIDER-MISMATCH-CANARY";

beforeAll(async () => {
  ctx = await createHttpTestServer("sensitive-result-authentication");
  const workflow = await createWorkflowRow(ctx, {
    name: "Sensitive source identity",
    slug: "sensitive-source-identity",
    execution_privacy: "sensitive",
    steps: [{ id: "echo", kind: "transform", language: "javascript", expression: "return 1;" }],
  });
  executionId = await createExecution(ctx.db, {
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    hold_writes: true,
    execution_privacy: "sensitive",
    input: { text: secret },
    caller_context: {
      tenantId: ctx.tenantId,
      principalId: ctx.userId,
      principalKind: "user",
      provider: "browser_session",
      productId: null,
    },
  });
  await ctx.db
    .update(executions)
    .set({
      status: "succeeded",
      sensitive_result: protectExecutionPayload(
        { text: secret },
        ctx.tenantId,
        executionId,
        "result",
      ),
    })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
}, 30_000);

afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, 30_000);

for (const action of ["result", "rerun"]) {
  test(`sensitive ${action} refuses the same user authenticated through another provider with audited 403`, async () => {
    const response = await fetch(`${ctx.baseUrl}/v1/executions/${executionId}/${action}`, {
      method: action === "rerun" ? "POST" : "GET",
      headers: { Authorization: `Bearer ${ctx.apiKey}`, "Content-Type": "application/json" },
      ...(action === "rerun" ? { body: JSON.stringify({ hold_writes: true }) } : {}),
    });
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("sensitive_resume_forbidden");
    expect(body).not.toContain(secret);
    const rows = await ctx.db
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    expect(rows).toEqual([{ id: executionId, status: "succeeded" }]);
    const audit = await ctx.db
      .select({ reason: auditLog.reason, action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, executionId)));
    expect(audit).toContainEqual({
      reason: "sensitive_resume_forbidden",
      action: "execution.boundary_refused",
    });
  });
}
