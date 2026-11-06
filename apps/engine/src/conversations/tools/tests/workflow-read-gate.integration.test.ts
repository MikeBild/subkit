import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { callToolViaDispatcher } from "../../../mcp/adapter.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx, seedUuid, seedWorkflow } from "../../../test-helpers/seed.ts";
import { getWorkflowTool, listWorkflowsTool } from "../engine-api/workflows.ts";
import { checkBeforeGate } from "../sdk-wrap/pregate.ts";

const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const ADMIN_ID = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";

let ctx: HttpTestServer;
let workflowId: string;
let deniedKey: string;
let denied: ResolvedPrincipal;
let admin: ResolvedPrincipal;

interface McpError {
  error_code?: string;
  message?: string;
  details?: unknown;
  next_best_actions?: string[];
}

async function httpGet(path: string, key: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return { status: res.status, body: await res.json() };
}

async function mcp(
  principal: ResolvedPrincipal,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: McpError & Record<string, unknown> }> {
  const res = await callToolViaDispatcher({
    db: ctx.db,
    principal,
    mcpMode: "admin",
    readOnly: false,
    invocation: { surface: "mcp", name, args },
  });
  return { isError: res.isError, body: JSON.parse(res.content[0]?.text ?? "{}") };
}

async function deniedAuditRows(resourceId: string) {
  return ctx.db
    .select({ resource_type: auditLog.resource_type, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "policy.denied"),
        eq(auditLog.resource_id, resourceId),
      ),
    );
}

beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_read_gate");
  const seeded = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 1),
    version: { id: seedUuid("workflow_version", 1) },
    slug: "gated-read",
    name: "Gated read",
  });
  workflowId = seeded.workflow.id;
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-workflow-read@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!user) throw new Error("denied user insert returned no row");
  denied = {
    provider: "test",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    roles: ["no-permissions"],
  };
  admin = {
    provider: "test",
    kind: "user",
    id: ADMIN_ID,
    tenant_id: ctx.tenantId,
    roles: ["admin"],
  };
  deniedKey = `wf_live_${createDeterministicHexFactory(0x60_1e)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      user.id,
      deniedKey.slice(0, 12),
      createHash("sha256").update(deniedKey).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workflow read tools carry the HTTP permission", () => {
  test("both tools declare workflow:read", () => {
    expect(listWorkflowsTool.permission?.action).toBe("workflow:read");
    expect(listWorkflowsTool.permission?.resourceType).toBe("workflow");
    expect(getWorkflowTool.permission?.action).toBe("workflow:read");
    expect(getWorkflowTool.permission?.resourceType).toBe("workflow");
    expect(typeof getWorkflowTool.permission?.resolveResourceId).toBe("function");
  });

  test("get_workflow checks the same workflow id whether called by id or by slug", async () => {
    const resolve = getWorkflowTool.permission?.resolveResourceId;
    if (!resolve) throw new Error("get_workflow has no resource resolver");
    const toolCtx = { db: ctx.db, tenant_id: ctx.tenantId } as Parameters<typeof resolve>[0];
    expect(await resolve(toolCtx, { id: workflowId })).toBe(workflowId);
    expect(await resolve(toolCtx, { slug: "gated-read" })).toBe(workflowId);
    expect(await resolve(toolCtx, { slug: "no-such-workflow" })).toBeNull();
    expect(await resolve(toolCtx, {})).toBeNull();
  });

  test("list_workflows without workflow:read is denied like GET /v1/workflows", async () => {
    const res = await mcp(denied, "list_workflows", {});
    expect(res.isError).toBe(true);
    expect(res.body.error_code).toBe("policy_denied");
    expect(res.body.message).toBe(
      "you lack workflow:read; request a grant or a key with that permission",
    );
    expect(res.body.details).toEqual({ required: "workflow:read", cause: "no_matching_grant" });
    expect(res.body).not.toHaveProperty("items");
    const http = await httpGet("/v1/workflows", deniedKey);
    expect(http.status).toBe(403);
    expect(http.body).toMatchObject({ hint: res.body.message, details: res.body.details });
  });

  test("get_workflow without workflow:read is denied like GET /v1/workflows/{id}", async () => {
    const res = await mcp(denied, "get_workflow", { id: workflowId });
    expect(res.isError).toBe(true);
    expect(res.body.error_code).toBe("policy_denied");
    expect(res.body.message).toBe(
      `you lack workflow:read on workflow ${workflowId}; request a grant or a key with that permission`,
    );
    expect(res.body.details).toEqual({
      required: "workflow:read",
      resource: { type: "workflow", id: workflowId },
      cause: "no_matching_grant",
    });
    expect(res.body).not.toHaveProperty("workflow");
    const rows = await deniedAuditRows(workflowId);
    expect(rows.map((r) => r.resource_type)).toContain("workflow");
    const http = await httpGet(`/v1/workflows/${workflowId}`, deniedKey);
    expect(http.status).toBe(403);
    expect(http.body).toMatchObject({ hint: res.body.message, details: res.body.details });
  });

  test("the chat pregate refuses both tools with permission_denied", async () => {
    const toolCtx = makeToolCtx({ db: ctx.db, tenant_id: ctx.tenantId, principal: denied });
    const list = await checkBeforeGate(listWorkflowsTool, toolCtx, {});
    const get = await checkBeforeGate(getWorkflowTool, toolCtx, { id: workflowId });
    for (const check of [list, get]) {
      expect(check.ok).toBe(false);
      if (check.ok) continue;
      expect(check.result).toMatchObject({
        ok: false,
        data: { error: "permission_denied", permission: "workflow:read" },
      });
    }
  });

  test("a denied caller learns nothing about an unknown id", async () => {
    const res = await mcp(denied, "get_workflow", { id: MISSING });
    expect(res.body.error_code).toBe("policy_denied");
  });
});

describe("get_workflow reports an unknown workflow as workflow_not_found", () => {
  test("unknown id and unknown slug share the error code", async () => {
    const byId = await mcp(admin, "get_workflow", { id: MISSING });
    const bySlug = await mcp(admin, "get_workflow", { slug: "no-such-workflow" });
    expect(byId.isError).toBe(true);
    expect(bySlug.isError).toBe(true);
    expect(byId.body.error_code).toBe("workflow_not_found");
    expect(bySlug.body.error_code).toBe("workflow_not_found");
    expect(byId.body).toEqual({
      error_code: "workflow_not_found",
      message: "workflow_not_found",
      details: { error: "workflow_not_found" },
      next_best_actions: [],
    });
    expect(bySlug.body).toEqual(byId.body);
  });

  test("under a confirm policy the pregate stops an unknown id with the same code", async () => {
    const toolCtx = makeToolCtx({ db: ctx.db, tenant_id: ctx.tenantId, principal: admin });
    const check = await checkBeforeGate(getWorkflowTool, toolCtx, { id: MISSING });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.result).toMatchObject({ ok: false, error_code: "workflow_not_found" });
  });

  test("an admin still reads the catalog and the workflow", async () => {
    const list = await mcp(admin, "list_workflows", {});
    expect(list.isError).toBe(false);
    expect(list.body.total).toBe(1);
    const get = await mcp(admin, "get_workflow", { id: workflowId });
    expect(get.isError).toBe(false);
    expect((get.body.workflow as { id?: string } | undefined)?.id).toBe(workflowId);
  });
});
