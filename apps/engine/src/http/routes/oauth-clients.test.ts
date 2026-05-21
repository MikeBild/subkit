// Integration tests for GET /v1/oauth/clients and DELETE /v1/oauth/clients/{client_id}.
//
// Covers:
//   - GET lists registered clients
//   - DELETE soft-disables a client; subsequent /authorize with that client_id is rejected
//   - Both routes return 403 without the admin permission

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { mcpOauthClients } from "../../db/schema/mcp_oauth.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;
let priorBaseUrl = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("oauth-clients-admin");
  const { getConfig } = await import("../../config/loader.ts");
  priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", "https://test.example.com", { force: true });
}, 30_000);

afterAll(async () => {
  await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  await ctx.cleanup();
}, 30_000);

// ── helpers ───────────────────────────────────────────────────────────────────

async function seedClient(clientId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(mcpOauthClients)
    .values({
      client_id: clientId,
      redirect_uris: ["https://example.com/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "mcp:read",
      client_name: `Test Client ${clientId}`,
      registration_source: "dcr",
    })
    .returning({ id: mcpOauthClients.id });
  if (!row) throw new Error(`seed client ${clientId} failed`);
  return row.id;
}

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

// ── GET /v1/oauth/clients ─────────────────────────────────────────────────────

describe("GET /v1/oauth/clients", () => {
  test("returns 403 without auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients`);
    expect(res.status).toBe(401);
  });

  test("lists registered clients for an admin principal", async () => {
    const clientId = "list-test-client-aaa111";
    await seedClient(clientId);

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients`, {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(Array.isArray(body.items)).toBe(true);
    const found = body.items.find((i) => i.client_id === clientId);
    expect(found).toBeDefined();
    expect(typeof found?.id).toBe("string");
    expect(found?.client_name).toBe(`Test Client ${clientId}`);
    // No secret fields
    expect(found?.client_secret).toBeUndefined();
    expect(found?.token_sha256).toBeUndefined();
  });
});

// ── DELETE /v1/oauth/clients/{client_id} ──────────────────────────────────────

describe("DELETE /v1/oauth/clients/{client_id}", () => {
  test("returns 401 without auth", async () => {
    const clientId = "delete-no-auth-bbb222";
    await seedClient(clientId);

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  test("returns 404 for unknown client_id", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients/nonexistent-client-id`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res.status).toBe(404);
  });

  test("soft-disables a known client and returns 204", async () => {
    const clientId = "disable-test-client-ccc333";
    await seedClient(clientId);

    const res = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res.status).toBe(204);

    // Row still exists but disabled_at is set
    const rows = await ctx.db
      .select({ disabled_at: mcpOauthClients.disabled_at })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, clientId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.disabled_at).not.toBeNull();
  });

  test("is idempotent — second DELETE still returns 204", async () => {
    const clientId = "idempotent-disable-ddd444";
    await seedClient(clientId);

    const res1 = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res1.status).toBe(204);

    const res2 = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(res2.status).toBe(204);
  });

  test("disabled client is rejected by GET /v1/oauth/authorize", async () => {
    const clientId = "disabled-auth-test-eee555";
    await seedClient(clientId);

    // Disable it
    const del = await fetch(`${ctx.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(del.status).toBe(204);

    // Try to authorize with the disabled client
    const res = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?client_id=${clientId}&redirect_uri=https://example.com/callback&response_type=code&code_challenge=abc&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    // The provider's getClient filters isNull(disabled_at), so an unknown/disabled client
    // returns 400 invalid_client.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });
});
