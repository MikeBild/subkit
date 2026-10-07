import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuthProviderRegistry } from "../../auth/registry.ts";
import { executions, systemAccounts, workflowSignals } from "../../db/schema/index.ts";
import { protectExecutionPayload } from "../../execution/sensitive-payload.ts";
import { createExecution } from "../../execution/state.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let executionId: string;
let sensitiveExecutionId: string;
const secret = "OWNER-ONLY-EXECUTION-INPUT";

beforeAll(async () => {
  const registry = new AuthProviderRegistry().register({
    name: "test",
    capabilities: { human: true, machine: true, interactive: false, refresh: false, revoke: false },
    async resolve(request) {
      const token = request.headers.get("authorization");
      if (!token || !["Bearer owner", "Bearer other", "Bearer same-id-machine"].includes(token))
        return null;
      return {
        provider: "test",
        kind: token === "Bearer owner" ? "user" : "system_account",
        id: token === "Bearer other" ? ctx.systemAccountId : ctx.userId,
        tenant_id: ctx.tenantId,
        product_id: "harmoniqs",
        roles: ["admin"],
      };
    },
  });
  ctx = await createHttpTestServer("execution-owner-isolation", { appOptions: { registry } });
  await ctx.db.insert(systemAccounts).values({
    id: ctx.userId,
    tenant_id: ctx.tenantId,
    name: "Distinct principal kind sharing an identifier",
  });
  const { workflow_id, version_id } = await createWorkflowRow(ctx, {
    name: "Owner execution fixture",
    slug: "owner-execution-fixture",
    product_id: "harmoniqs",
    steps: [{ id: "echo", kind: "transform", expression: "return input.input;" }],
  });
  executionId = await createExecution(ctx.db, {
    tenant_id: ctx.tenantId,
    workflow_id,
    workflow_version_id: version_id,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    hold_writes: true,
    input: { content: secret },
    caller_context: {
      tenantId: ctx.tenantId,
      principalId: ctx.userId,
      principalKind: "user",
      provider: "test",
      productId: "harmoniqs",
    },
  });
  sensitiveExecutionId = await createExecution(ctx.db, {
    tenant_id: ctx.tenantId,
    workflow_id,
    workflow_version_id: version_id,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    hold_writes: true,
    input: { content: secret },
    execution_privacy: "sensitive",
    caller_context: {
      tenantId: ctx.tenantId,
      principalId: ctx.userId,
      principalKind: "user",
      provider: "test",
      productId: "harmoniqs",
    },
  });
  await ctx.db
    .update(executions)
    .set({
      status: "succeeded",
      sensitive_result: protectExecutionPayload(
        { text: secret },
        ctx.tenantId,
        sensitiveExecutionId,
        "result",
      ),
    })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, sensitiveExecutionId)));
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe("execution owner isolation within a tenant", () => {
  for (const path of ["", "/steps", "/stream", "/cost"]) {
    test(`another principal cannot read execution${path || " detail"}`, async () => {
      const response = await fetch(`${ctx.baseUrl}/v1/executions/${executionId}${path}`, {
        headers: { Authorization: "Bearer other" },
      });
      expect([403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(secret);
    });
  }

  test("the owner can read execution details and steps", async () => {
    for (const path of ["", "/steps"]) {
      const response = await fetch(`${ctx.baseUrl}/v1/executions/${executionId}${path}`, {
        headers: { Authorization: "Bearer owner" },
      });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
  });

  test("execution lists omit another owner's execution", async () => {
    const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
      headers: { Authorization: "Bearer other" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(executionId);
  });

  test("another principal cannot cancel or change an owner's queued execution", async () => {
    const response = await fetch(`${ctx.baseUrl}/v1/executions/${executionId}/cancel`, {
      method: "POST",
      headers: { Authorization: "Bearer other" },
    });
    expect([403, 404]).toContain(response.status);
    const [row] = await ctx.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
    expect(row?.status).toBe("queued");
    expect(row?.abort_requested_at).toBeNull();
  });

  test("a machine principal sharing the user identifier is still a different owner", async () => {
    for (const method of ["GET", "POST"]) {
      const path = method === "POST" ? "/cancel" : "";
      const response = await fetch(`${ctx.baseUrl}/v1/executions/${executionId}${path}`, {
        method,
        headers: { Authorization: "Bearer same-id-machine" },
      });
      expect([403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(secret);
    }
  });

  test("foreign and sibling-kind principals cannot rerun or signal an owner's execution", async () => {
    for (const token of ["other", "same-id-machine"]) {
      for (const path of ["rerun", "signals"]) {
        const response = await fetch(`${ctx.baseUrl}/v1/executions/${executionId}/${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(path === "signals" ? { event: "owner-event" } : {}),
        });
        expect([403, 404]).toContain(response.status);
        expect(await response.text()).not.toContain(secret);
      }
    }
    const reruns = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenantId),
          eq(executions.parent_execution_id, executionId),
        ),
      );
    const signals = await ctx.db
      .select({ id: workflowSignals.id })
      .from(workflowSignals)
      .where(
        and(
          eq(workflowSignals.tenant_id, ctx.tenantId),
          eq(workflowSignals.execution_id, executionId),
        ),
      );
    expect(reruns).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });

  test("only the original caller can read a sensitive asynchronous result", async () => {
    const path = `${ctx.baseUrl}/v1/executions/${sensitiveExecutionId}/result`;
    for (const token of ["other", "same-id-machine"]) {
      const denied = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
      expect([403, 404]).toContain(denied.status);
      expect(await denied.text()).not.toContain(secret);
    }
    const allowed = await fetch(path, { headers: { Authorization: "Bearer owner" } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ result: { text: secret } });
  });
});
