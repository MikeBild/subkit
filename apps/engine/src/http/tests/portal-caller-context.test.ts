import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, connectors, executions, portalTokens } from "../../db/schema/index.ts";
import { CallerContextSchema } from "../../execution/caller-context.ts";
import { authorizeSensitiveResume } from "../../execution/sensitive-payload.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { generatePortalToken } from "../../identity/portal-token.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let workflowId: string;
let egressWorkflowId: string;
let connectorId: string;
let token: string;
let mock: MockServer;
const ownerId = "external-crm-contact-42";

beforeAll(async () => {
  ctx = await createHttpTestServer("portal-caller-context");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
  const workflow = await createWorkflowRow(ctx, {
    name: "Portal caller identity",
    slug: "portal-caller-identity",
    steps: [
      {
        id: "identity",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.$caller;",
      },
    ],
  });
  workflowId = workflow.workflow_id;
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "portal-egress",
      display_name: "Portal egress",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
    })
    .returning({ id: connectors.id });
  if (!connector) throw new Error("portal egress connector fixture missing");
  connectorId = connector.id;
  const egressWorkflow = await createWorkflowRow(ctx, {
    name: "Portal connector egress",
    slug: "portal-connector-egress",
    steps: [
      {
        id: "fetch",
        kind: "request",
        method: "GET",
        connector_id: connectorId,
        path: "/health",
        max_retries: 0,
      },
    ],
  });
  egressWorkflowId = egressWorkflow.workflow_id;
  const issued = generatePortalToken();
  token = issued.plaintext;
  await ctx.db.insert(portalTokens).values({
    tenant_id: ctx.tenantId,
    enduser_ref: ownerId,
    prefix: issued.prefix,
    token_sha256: issued.hash,
    allowed_workflows: [workflowId],
    expires_at: sql`clock_timestamp() + interval '1 hour'`,
  });
}, 30_000);

afterAll(async () => {
  if (mock) await mock.close();
  if (ctx) await ctx.cleanup();
}, 30_000);

describe("portal caller identity compatibility", () => {
  test("opaque portal owners cannot resume sensitive executions via UUID database lookup", async () => {
    const principal = {
      provider: "portal_token",
      kind: "user" as const,
      id: ownerId,
      tenant_id: ctx.tenantId,
      roles: ["enduser"],
    };
    const row = {
      tenant_id: ctx.tenantId,
      caller_context: {
        tenantId: ctx.tenantId,
        principalId: ownerId,
        principalKind: "user" as const,
        provider: "portal_token",
        productId: null,
      },
    };
    for (const internal of [false, true]) {
      await expect(
        authorizeSensitiveResume(ctx.db, row, principal, internal),
      ).rejects.toMatchObject({
        code: "sensitive_resume_forbidden",
      });
    }
  });

  test("opaque portal owners execute synchronously with authenticated caller despite spoofed input", async () => {
    const caller = {
      tenantId: ctx.tenantId,
      principalId: ownerId,
      principalKind: "user" as const,
      provider: "portal_token",
      productId: null,
    };
    const spoofed = { ...caller, principalId: ctx.userId, productId: "harmoniqs" };
    const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        hold_writes: true,
        async: false,
        input: { $caller: spoofed, caller: spoofed, caller_context: spoofed },
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe("succeeded");
    expect(body.output).toEqual(caller);
    const [row] = await ctx.db
      .select({ caller: executions.caller_context })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, body.execution_id)));
    expect(row?.caller).toEqual(caller);
  });

  test("opaque portal owners can run connector egress without violating the UUID audit actor column", async () => {
    const runEgressWorkflow = () =>
      fetch(`${ctx.baseUrl}/v1/executions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "saved",
          workflow_id: egressWorkflowId,
          hold_writes: true,
          async: false,
          input: {},
        }),
      });
    const denied = await runEgressWorkflow();
    expect(denied.status).toBe(403);
    const [denial] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "policy.denied"),
          eq(auditLog.resource_id, egressWorkflowId),
        ),
      );
    expect(denial).toEqual({ actor_type: "user", actor_id: null });
    await ctx.db
      .update(portalTokens)
      .set({ allowed_workflows: [workflowId, egressWorkflowId] })
      .where(and(eq(portalTokens.tenant_id, ctx.tenantId), eq(portalTokens.enduser_ref, ownerId)));
    const response = await runEgressWorkflow();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe("succeeded");
    expect(mock.callCount()).toBe(1);
    const [entry] = await ctx.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "connector.invoked"),
          eq(auditLog.resource_id, connectorId),
        ),
      );
    expect(entry).toMatchObject({
      actor_type: "unknown",
      actor_id: null,
      metadata: {
        execution_id: body.execution_id,
        workflow_id: egressWorkflowId,
        step_id: "fetch",
      },
    });
  });

  test("opaque IDs are accepted only for nonempty generic portal user callers", () => {
    const caller = {
      tenantId: "00000000-0000-4000-8000-000000000031",
      principalId: ownerId,
      principalKind: "user",
      provider: "portal_token",
      productId: null,
    };
    expect(CallerContextSchema.safeParse(caller).success).toBe(true);
    for (const override of [
      { provider: "api_key" },
      { principalKind: "system_account" },
      { productId: "harmoniqs" },
      { principalId: "" },
    ]) {
      expect(CallerContextSchema.safeParse({ ...caller, ...override }).success).toBe(false);
    }
  });
});
