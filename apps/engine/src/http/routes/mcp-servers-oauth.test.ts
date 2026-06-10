// Integration tests for the interactive MCP-client OAuth routes (#171
// follow-up):
//   POST /v1/mcp-servers/{id}/authorize
//   GET  /v1/mcp-servers/oauth/callback
//
// Mirrors mcp-servers.test.ts: real Postgres via createHttpTestServer, real
// HTTP via fetch, no domain-layer mocking. These cases all short-circuit
// BEFORE the SDK `auth()` network round-trip, so no fake authorization
// server is needed:
//   - authorize on a non-oauth2 server → 422 (the kind guard fires first)
//   - authorize WITHOUT mcp_server:manage → 403 (permission gate)
//   - callback with an unknown state → error HTML page (400), not a 500
//   - callback with an expired/used state → single-use enforced (error page)
//
// The full happy-path round-trip with a mock AS is left to the
// test-generator.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, mcpOauthStates, users } from "../../db/schema/index.ts";
import { createRole } from "../../rbac/roles.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

// Deterministic "already expired" timestamp: a fixed point well in the past
// (the frozen reference clock) so the guarded `WHERE expires_at > now()`
// delete never matches it, without reading the wall clock.
const EXPIRED_STATE_AT = new Date(FROZEN_NOW - 60_000);

let ctx: HttpTestServer;
let memberApiKey = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("mcp-servers-oauth-routes");

  // Principal with NO mcp_server:manage permission (empty role).
  const noopRole = await createRole(ctx.db, ctx.tenantId, "noop-mcp-oauth", "no permissions");
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-mcp-oauth@test.local",
      role: "member",
      role_id: noopRole.id,
    })
    .returning();
  if (!member) throw new Error("seed member failed");

  const rand = createHash("sha256").update("member-mcp-oauth-seed").digest("hex").slice(0, 32);
  memberApiKey = `wf_live_${rand}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: memberApiKey.slice(0, 12),
    token_sha256: createHash("sha256").update(memberApiKey).digest("hex"),
    scopes: ["*"],
  });
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

function adminAuth(): { Authorization: string } {
  return { Authorization: `Bearer ${ctx.apiKey}` };
}
function memberAuth(): { Authorization: string } {
  return { Authorization: `Bearer ${memberApiKey}` };
}

/** Register an MCP server of the given auth kind, returning its id. */
async function createServer(kind: "none" | "oauth2", namespace: string): Promise<string> {
  const body: Record<string, unknown> = {
    name: `Server ${namespace}`,
    namespace,
    transport: "http",
    url: "https://example.mcp.test",
  };
  if (kind === "oauth2") {
    body.auth_config = { kind: "oauth2", issuer: "https://idp.example.test", scope: "read" };
    body.refresh_token = "seed-refresh-token";
  }
  const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
    method: "POST",
    headers: { ...adminAuth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string };
  return json.id;
}

// ── POST /v1/mcp-servers/{id}/authorize ───────────────────────────────────────

describe("POST /v1/mcp-servers/{id}/authorize", () => {
  test("returns 422 for a non-oauth2 server", async () => {
    const id = await createServer("none", "noauthsrv");
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${id}/authorize`, {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(422);
    // No in-flight state row may be left behind by a rejected authorize.
    const rows = await ctx.db
      .select()
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, ctx.tenantId), eq(mcpOauthStates.mcp_server_id, id)));
    expect(rows.length).toBe(0);
  });

  test("returns 403 for a member without mcp_server:manage", async () => {
    const id = await createServer("oauth2", "memberoauthsrv");
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${id}/authorize`, {
      method: "POST",
      headers: memberAuth(),
    });
    expect(res.status).toBe(403);
  });

  test("returns 401 without auth", async () => {
    const id = await createServer("oauth2", "anonoauthsrv");
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${id}/authorize`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

// ── GET /v1/mcp-servers/oauth/callback ────────────────────────────────────────

describe("GET /v1/mcp-servers/oauth/callback", () => {
  test("renders an error page (not 500) for an unknown state", async () => {
    const res = await fetch(
      `${ctx.baseUrl}/v1/mcp-servers/oauth/callback?state=does-not-exist&code=abc`,
    );
    // 400 HTML error page — never a 500.
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("expired");
  });

  test("enforces single-use: an expired state row renders the error page", async () => {
    const id = await createServer("oauth2", "expiredstatesrv");
    // Insert an already-expired in-flight row directly. The atomic
    // DELETE … WHERE expires_at > now() must NOT match it.
    const state = "expired-state-token";
    await ctx.db.insert(mcpOauthStates).values({
      tenant_id: ctx.tenantId,
      mcp_server_id: id,
      state,
      code_verifier: "verifier",
      redirect_uri: "https://engine.example.test/v1/mcp-servers/oauth/callback",
      expires_at: EXPIRED_STATE_AT,
    });

    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/oauth/callback?state=${state}&code=abc`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");

    // The expired row is left untouched (the guarded delete did not match);
    // no token exchange ran.
    const rows = await ctx.db
      .select()
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, ctx.tenantId), eq(mcpOauthStates.state, state)));
    expect(rows.length).toBe(1);
  });
});
