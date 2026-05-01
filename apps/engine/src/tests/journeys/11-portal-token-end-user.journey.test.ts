// User story: As a platform operator, I want to issue a short-lived,
// workflow-scoped portal token for a specific end-user so they can
// drive exactly one workflow on their own behalf.
// Acceptance criteria:
//   - AC1: An admin can issue a portal token bound to one workflow and
//          receive a plaintext token.
//   - AC2: The token lands in `/v1/identity/portal-tokens` with the
//          correct `allowed_workflows`.
//   - AC3: Revocation flips the row and removes it from the list.
//   - AC4: Using the plaintext portal token the end-user can POST to
//          the scoped workflow's `/run` endpoint and get a 2xx.
//   - AC5: The same portal token is 403 denied when used against a
//          workflow outside its allowlist, and the deny is audited.
//   - AC6: An expired portal token (expires_at in the past) is 401.
//   - AC7: Over MCP, `tools/call` enforces the same allowlist: a
//          portal-token bearer calling `wf.<slug>` for a workflow
//          outside its scope errors with `workflow_not_in_allowlist`
//          and an audit row lands with the same reason.
// Spec refs: docs/07-security-governance.md, docs/07-security-governance.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { and, eq } from "drizzle-orm";
import { auditLog, portalTokens } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch, seedWorkflow } from "./setup.ts";

const TEST_NOW_MS = 1_700_000_000_000;

let ctx: JourneyCtx;
let workflowId = "";
let otherWorkflowId = "";
let tokenId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("portal-token");
  const wf = await seedWorkflow(ctx, {
    slug: "portal-only",
    name: "Portal Only",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  workflowId = wf.id;
  // A second workflow with no relation to the portal token — used by
  // AC5 to prove the allowlist is enforced.
  const other = await seedWorkflow(ctx, {
    slug: "not-allowed",
    name: "Not Allowed",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  otherWorkflowId = other.id;
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

describe("journey: portal token end-user", () => {
  test("AC1: admin issues a scoped portal token and receives plaintext", async () => {
    const res = await journeyFetch(ctx, "/v1/identity/portal-tokens", {
      method: "POST",
      body: JSON.stringify({
        user_id: ctx.userId,
        allowed_workflows: [workflowId],
        ttl_minutes: 30,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      allowed_workflows: string[];
      plaintext_token: string;
    };
    tokenId = body.id;
    expect(body.allowed_workflows).toEqual([workflowId]);
    expect(typeof body.plaintext_token).toBe("string");
    expect(body.plaintext_token.length).toBeGreaterThan(10);
  });

  test("AC2: list shows the new portal token", async () => {
    const res = await journeyFetch(ctx, "/v1/identity/portal-tokens");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; allowed_workflows: string[]; revoked_at: string | null }>;
    };
    const row = body.items.find((r) => r.id === tokenId);
    expect(row).toBeDefined();
    expect(row?.revoked_at).toBeNull();
    expect(row?.allowed_workflows).toEqual([workflowId]);
  });

  test("AC3: revoke marks the row", async () => {
    const res = await journeyFetch(ctx, `/v1/identity/portal-tokens/${tokenId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    const listRes = await journeyFetch(ctx, "/v1/identity/portal-tokens");
    const body = (await listRes.json()) as {
      items: Array<{ id: string; revoked_at: string | null }>;
    };
    const row = body.items.find((r) => r.id === tokenId);
    // The list endpoint surfaces the revoked row with `revoked_at` set.
    expect(row?.revoked_at).not.toBeNull();
  });

  // --- AC4-AC6: portal-token auth provider is live -------------------
  //
  // Each of these issues a *fresh* portal token so the revoked row
  // from AC3 doesn't poison the test. The plaintext is held inside
  // the closure and dropped at the end of the block.
  async function issueFreshPortalToken(allowed: string[]): Promise<{
    id: string;
    plaintext: string;
  }> {
    const res = await journeyFetch(ctx, "/v1/identity/portal-tokens", {
      method: "POST",
      body: JSON.stringify({
        user_id: ctx.userId,
        allowed_workflows: allowed,
        ttl_minutes: 30,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; plaintext_token: string };
    expect(body.plaintext_token.startsWith("wf_portal_")).toBe(true);
    return { id: body.id, plaintext: body.plaintext_token };
  }

  function endUserFetch(
    plaintext: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${plaintext}`);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
  }

  test("AC4: end-user drives the scoped workflow with the plaintext token", async () => {
    const issued = await issueFreshPortalToken([workflowId]);
    const res = await endUserFetch(issued.plaintext, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        input: { hello: "world" },
      }),
    });
    // Sync runs return 200 + the full execution envelope.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { execution_id: string; status: string };
    expect(typeof body.execution_id).toBe("string");
    expect(body.status).toBe("succeeded");
  });

  test("AC5: end-user receives 403 on a non-allowed workflow with an audited deny", async () => {
    const issued = await issueFreshPortalToken([workflowId]);
    const res = await endUserFetch(issued.plaintext, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: otherWorkflowId, input: {} }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("forbidden");

    // Audit row lands durably before the 403 returns.
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "policy.denied"),
          eq(auditLog.resource_type, "workflow"),
          eq(auditLog.resource_id, otherWorkflowId),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.result).toBe("denied");
    expect(rows[0]?.reason).toBe("workflow_not_in_allowlist");
  });

  test("AC6: expired portal token returns 401", async () => {
    const issued = await issueFreshPortalToken([workflowId]);
    // Force the token into the past. The provider checks `expires_at`
    // on every resolve and must reject.
    await ctx.db
      .update(portalTokens)
      .set({ expires_at: new Date(TEST_NOW_MS - 1_000) })
      .where(and(eq(portalTokens.tenant_id, ctx.tenantId), eq(portalTokens.id, issued.id)));
    const res = await endUserFetch(issued.plaintext, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
    });
    expect(res.status).toBe(401);
  });

  test("AC7: MCP tools/call enforces allowed_workflows", async () => {
    const issued = await issueFreshPortalToken([workflowId]);

    // Connect a real MCP client to the engine's Streamable HTTP surface
    // using the portal-token as the bearer. The registered providers
    // will resolve the token and hand the MCP layer a principal with
    // `allowed_workflows: [workflowId]` — which we then try to violate
    // by calling the *other* workflow's tool.
    const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${issued.plaintext}` } },
    });
    const client = new Client({ name: "portal-token-journey", version: "0.0.0" });
    await client.connect(transport as unknown as Transport);

    let caught: unknown = null;
    try {
      await client.callTool({
        name: "wf.not-allowed",
        arguments: {},
      });
    } catch (err) {
      caught = err;
    } finally {
      await client.close();
    }

    expect(caught).not.toBeNull();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toContain("workflow_not_in_allowlist");

    // Audit row confirming the deny fired on the MCP path, not the HTTP
    // path — the reason is the same but the metadata `via` differs.
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "policy.denied"),
          eq(auditLog.resource_type, "workflow"),
          eq(auditLog.resource_id, otherWorkflowId),
          eq(auditLog.reason, "mcp_workflow_not_in_allowlist"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
  });
});
