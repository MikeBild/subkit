// Session ↔ principal binding.
//
// `transports/streamable-http.ts` caches per-session transports keyed by the
// `mcp-session-id` header, and the per-session `server` closes over the
// principal that ran `initialize`. A leaked session id must NOT let a second
// valid credential execute inside the owner's tenant context — that is a
// session-hijack / confused-deputy path the MCP Security Best Practices
// forbid ("sessions MUST NOT be used for authentication"; bind the session id
// to the authorized user). A request whose principal does not match the
// session owner is answered with the same 404 the stale-session branch
// returns, disclosing nothing about the id.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("streamable-http-session-binding");
});

afterAll(async () => {
  await suite.cleanup();
});

async function initialize(apiKey: string): Promise<string> {
  const res = await fetch(`${suite.http.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "session-binding-test", version: "0.0.0" },
      },
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(typeof sessionId).toBe("string");
  return sessionId!;
}

async function pingWithKey(
  sessionId: string,
  apiKey: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${suite.http.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping", params: {} }),
  });
  return { status: res.status, text: await res.text() };
}

describe("streamable-http transport — session ↔ principal binding", () => {
  test("a different principal presenting a live session id is rejected with 404", async () => {
    // Owner opens a session.
    const sessionId = await initialize(suite.http.apiKey);

    // The owner's own follow-up still works (regression guard).
    const owned = await pingWithKey(sessionId, suite.http.apiKey);
    expect(owned.status).toBe(200);

    // A second, fully valid credential for a DIFFERENT tenant/user presents
    // the owner's session id.
    const [tenant] = await suite.http.db
      .insert(tenants)
      .values({ slug: "t-attacker", display_name: "Attacker Tenant" })
      .returning();
    if (!tenant) throw new Error("seed attacker tenant failed");
    const [user] = await suite.http.db
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: "attacker@test.local",
        role_id: await builtinRoleId(suite.http.db, "admin"),
      })
      .returning();
    if (!user) throw new Error("seed attacker user failed");
    const attacker = await suite.issueApiKeyForTenant(tenant.id, user.id, ["mcp:read"]);
    const hijack = await pingWithKey(sessionId, attacker.plaintext);

    expect(hijack.status).toBe(404);
    const body = JSON.parse(hijack.text) as {
      jsonrpc: string;
      error?: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toBe("Session not found");

    // The rejection must not have disturbed the owner's session.
    const stillOwned = await pingWithKey(sessionId, suite.http.apiKey);
    expect(stillOwned.status).toBe(200);
  });
});
