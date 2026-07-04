// Integration tests for /v1/mcp-servers routes.
//
// Mirrors the oauth-clients.test.ts pattern: real Postgres via
// createHttpTestServer, real HTTP via fetch, no mocking of domain layer.
//
// Coverage:
//   - CRUD happy path (POST → GET → list → PATCH → disable → enable → DELETE)
//   - bearer create with --token writes an mcp_server-owned credential and
//     the secret NEVER appears in any response
//   - auth_config is redacted on all read paths ({ kind, has_credential })
//   - RBAC: principal WITHOUT mcp_server:manage gets 403 on every route
//   - 404 for cross-tenant id and unknown id
//   - namespace validation rejection (__ ban → 422; stdio transport → 422)
//   - tenant isolation: admin of tenant B cannot read tenant A's rows

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, credentials, users } from "../../db/schema/index.ts";
import { createRole } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;
let memberApiKey = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("mcp-servers-routes");

  // Mint a principal with NO mcp_server:manage permission using an empty role.
  const noopRole = await createRole(ctx.db, ctx.tenantId, "noop-mcp-server", "no permissions");
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-mcp@test.local",
      role: "member",
      role_id: noopRole.id,
    })
    .returning();
  if (!member) throw new Error("seed member failed");

  const rand = createHash("sha256").update("member-mcp-seed").digest("hex").slice(0, 32);
  memberApiKey = `wf_live_${rand}`;
  const memberPrefix = memberApiKey.slice(0, 12);
  const memberHash = createHash("sha256").update(memberApiKey).digest("hex");
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: memberPrefix,
    token_sha256: memberHash,
    scopes: ["*"],
  });
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

// ── helpers ──────────────────────────────────────────────────────────────────

function adminAuth(): { Authorization: string } {
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

function memberAuth(): { Authorization: string } {
  return { Authorization: `Bearer ${memberApiKey}` };
}

/** Read the raw mcp_servers row from the DB so a test can assert what was
 *  persisted to `auth_config` (vs. what the redacted response returns). */
async function fetchServerRow(id: string): Promise<{ auth_config: unknown }> {
  const { mcpServers } = await import("../../db/schema/index.ts");
  const rows = await ctx.db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.tenant_id, ctx.tenantId), eq(mcpServers.id, id)))
    .limit(1);
  if (!rows[0]) throw new Error(`mcp_server ${id} not found`);
  return { auth_config: rows[0].auth_config };
}

async function createServer(overrides: Record<string, unknown> = {}): Promise<{
  id: string;
  namespace: string;
  auth_config: { kind: string; has_credential: boolean };
}> {
  const body = {
    name: "Example MCP",
    namespace: "examplemcp",
    transport: "http",
    url: "https://example.mcp.test",
    ...overrides,
  };
  const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
    method: "POST",
    headers: { ...adminAuth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{
    id: string;
    namespace: string;
    auth_config: { kind: string; has_credential: boolean };
  }>;
}

// ── POST /v1/mcp-servers ──────────────────────────────────────────────────────

describe("POST /v1/mcp-servers", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "X",
        namespace: "xns",
        transport: "http",
        url: "https://x.example.com",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for member without mcp_server:manage", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...memberAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "X",
        namespace: "memberxns",
        transport: "http",
        url: "https://x.example.com",
      }),
    });
    expect(res.status).toBe(403);
  });

  test("bearer create with --token writes a credential and never echoes the secret", async () => {
    const SECRET = "sk-bearer-secret-do-not-leak-7f3a";
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme MCP",
        namespace: "acmecreate",
        transport: "http",
        url: "https://acme.mcp.test",
        auth_config: { kind: "bearer" },
        token: SECRET,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Acme MCP");
    // auth_config is redacted: kind + has_credential but NEVER the secret.
    const auth = body.auth_config as { kind: string; has_credential: boolean };
    expect(auth.kind).toBe("bearer");
    expect(auth.has_credential).toBe(true);
    // The bearer secret must not appear anywhere in the response.
    expect(JSON.stringify(body)).not.toContain(SECRET);

    // A credential row was written, keyed by mcp_server_id, NOT a connector.
    const rows = await ctx.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, ctx.tenantId),
          eq(credentials.mcp_server_id, body.id as string),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.mode).toBe("bearer");
    expect(rows[0]!.connector_id).toBeNull();
    // The ciphertext must not be the plaintext secret.
    expect(Buffer.from(rows[0]!.ciphertext).toString("utf8")).not.toContain(SECRET);

    // The auth_config persisted on the row carries NO secret key.
    const stored = JSON.stringify((await fetchServerRow(body.id as string)).auth_config);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("token");
  });

  test("bearer create WITHOUT a token is rejected (422)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "No Secret MCP",
        namespace: "nosecretmcp",
        transport: "http",
        url: "https://nosecret.mcp.test",
        auth_config: { kind: "bearer" },
      }),
    });
    expect(res.status).toBe(422);
  });

  test("basic create with username+token writes a basic credential and never echoes either", async () => {
    const SECRET = "atl-api-token-do-not-leak-9c1d";
    const USERNAME = "user@basic.test";
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Basic MCP",
        namespace: "basiccreate",
        transport: "http",
        url: "https://basic.mcp.test",
        auth_config: { kind: "basic" },
        username: USERNAME,
        token: SECRET,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    const auth = body.auth_config as { kind: string; has_credential: boolean };
    expect(auth.kind).toBe("basic");
    expect(auth.has_credential).toBe(true);
    // Neither half of the pair appears anywhere in the response.
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(USERNAME);

    // A basic-mode credential row was written, keyed by mcp_server_id.
    const rows = await ctx.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, ctx.tenantId),
          eq(credentials.mcp_server_id, body.id as string),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.mode).toBe("basic");
    expect(Buffer.from(rows[0]!.ciphertext).toString("utf8")).not.toContain(SECRET);

    // The persisted auth_config carries ONLY the kind — no username, no token.
    const stored = JSON.stringify((await fetchServerRow(body.id as string)).auth_config);
    expect(stored).not.toContain(USERNAME);
    expect(stored).not.toContain("token");
  });

  test("basic create with token but WITHOUT username is rejected (422)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Half Basic MCP",
        namespace: "halfbasicmcp",
        transport: "http",
        url: "https://halfbasic.mcp.test",
        auth_config: { kind: "basic" },
        token: "lonely-token",
      }),
    });
    expect(res.status).toBe(422);
  });

  test("basic create with a refresh_token is rejected (422 — wrong field for the kind)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Wrong Field MCP",
        namespace: "wrongfieldmcp",
        transport: "http",
        url: "https://wrongfield.mcp.test",
        auth_config: { kind: "basic" },
        username: "u@x.test",
        token: "t",
        refresh_token: "rt",
      }),
    });
    expect(res.status).toBe(422);
  });

  test("oauth2 create WITHOUT a refresh_token succeeds (interactive authorize supplies it later)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Interactive OAuth MCP",
        namespace: "interactiveoauth",
        transport: "http",
        url: "https://interactive.mcp.test",
        auth_config: { kind: "oauth2" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // No credential row yet — the authorize consent flow mints it.
    const rows = await ctx.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, ctx.tenantId),
          eq(credentials.mcp_server_id, body.id as string),
        ),
      );
    expect(rows.length).toBe(0);
  });

  test("oauth2 create WITH a refresh_token writes the oauth2 credential", async () => {
    const REFRESH = "oauth2-refresh-do-not-leak-4b2e";
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Seeded OAuth MCP",
        namespace: "seededoauth",
        transport: "http",
        url: "https://seeded.mcp.test",
        auth_config: { kind: "oauth2" },
        refresh_token: REFRESH,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(REFRESH);
    const rows = await ctx.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, ctx.tenantId),
          eq(credentials.mcp_server_id, body.id as string),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.mode).toBe("oauth2");
  });

  test("rejects namespace with __ (400 — Hono/zod-openapi returns 400 for body validation failures)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bad NS",
        namespace: "bad__namespace",
        transport: "http",
        url: "https://bad.mcp.test",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects stdio transport (400 — enum http|sse only at route boundary)", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Stdio MCP",
        namespace: "stdions",
        transport: "stdio",
        url: "https://stdio.mcp.test",
      }),
    });
    // The CreateMcpServerBody schema only allows "http" | "sse", so "stdio" → 400.
    expect(res.status).toBe(400);
  });

  test("rejects namespace containing double-underscore (NamespaceSchema refine)", async () => {
    // Namespace with __ is the canonical invalid-slug case; also covers the
    // refine() path separate from the regex path (e.g. "a__b" passes the
    // character class but fails the .refine check).
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bad NS",
        namespace: "a__b",
        transport: "http",
        url: "https://bad3.mcp.test",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /v1/mcp-servers ───────────────────────────────────────────────────────

describe("GET /v1/mcp-servers", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`);
    expect(res.status).toBe(401);
  });

  test("returns 403 for member without mcp_server:manage", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, { headers: memberAuth() });
    expect(res.status).toBe(403);
  });

  test("admin sees their servers in the list", async () => {
    await createServer({ namespace: "listns1" });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, { headers: adminAuth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(Array.isArray(body.items)).toBe(true);
    const found = body.items.find((i) => i.namespace === "listns1");
    expect(found).toBeDefined();
    // auth_config must never carry a secret — only kind + has_credential.
    const auth = found?.auth_config as { kind: string; has_credential?: boolean };
    expect(auth).toBeDefined();
    expect(typeof auth.kind).toBe("string");
    expect(Object.keys(auth)).not.toContain("token");
    expect(Object.keys(auth)).not.toContain("token_ref");
  });
});

// ── GET /v1/mcp-servers/{id} ──────────────────────────────────────────────────

describe("GET /v1/mcp-servers/{id}", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/00000000-0000-0000-0000-000000000001`);
    expect(res.status).toBe(401);
  });

  test("returns 403 for member without mcp_server:manage", async () => {
    const row = await createServer({ namespace: "membergetns" });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}`, { headers: memberAuth() });
    expect(res.status).toBe(403);
  });

  test("returns 404 for unknown id", async () => {
    // Use a valid v4-format UUID that does not exist in the DB.
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/a0000000-0000-4000-8000-000000000099`, {
      headers: adminAuth(),
    });
    expect(res.status).toBe(404);
  });

  test("returns the server row with redacted auth_config", async () => {
    const SECRET = "sk-get-redacted-secret-9c1d";
    const created = await createServer({
      namespace: "getredactedns",
      auth_config: { kind: "bearer" },
      token: SECRET,
    });

    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${created.id}`, {
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const auth = body.auth_config as { kind: string; has_credential: boolean };
    expect(auth.has_credential).toBe(true);
  });
});

// ── PATCH /v1/mcp-servers/{id} ────────────────────────────────────────────────

describe("PATCH /v1/mcp-servers/{id}", () => {
  test("returns 403 for member without mcp_server:manage", async () => {
    const row = await createServer({ namespace: "memberpatchns" });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}`, {
      method: "PATCH",
      headers: { ...memberAuth(), "content-type": "application/json" },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(res.status).toBe(403);
  });

  test("returns 404 for unknown id", async () => {
    // Use a valid v4-format UUID that does not exist in the DB.
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/a0000000-0000-4000-8000-000000000088`, {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(404);
  });

  test("updates the server and returns redacted response", async () => {
    const row = await createServer({ namespace: "patchhappyns" });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}`, {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ name: "Patched MCP" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("Patched MCP");
  });

  test("rotates the bearer secret and never echoes it", async () => {
    const FIRST = "sk-patch-rotate-first-aa11";
    const SECOND = "sk-patch-rotate-second-bb22";
    const created = await createServer({
      namespace: "patchrotatens",
      auth_config: { kind: "bearer" },
      token: FIRST,
    });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${created.id}`, {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ auth_config: { kind: "bearer" }, token: SECOND }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Neither the old nor the new secret may appear in the response.
    expect(JSON.stringify(body)).not.toContain(FIRST);
    expect(JSON.stringify(body)).not.toContain(SECOND);
    const auth = body.auth_config as { kind: string; has_credential: boolean };
    expect(auth.has_credential).toBe(true);

    // Still exactly one mcp_server-owned credential row (rotation in place).
    const rows = await ctx.db
      .select()
      .from(credentials)
      .where(
        and(eq(credentials.tenant_id, ctx.tenantId), eq(credentials.mcp_server_id, created.id)),
      );
    expect(rows.length).toBe(1);
  });

  test("rejects a token rotation without auth_config (422)", async () => {
    const created = await createServer({
      namespace: "patchnokind",
      auth_config: { kind: "bearer" },
      token: "sk-patch-no-kind-cc33",
    });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${created.id}`, {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ token: "sk-rotation-without-kind" }),
    });
    expect(res.status).toBe(422);
  });

  test("rejects an oauth2_client_credentials secret rotation missing client_id (422)", async () => {
    // The PATCH path must apply the same M2M completeness guard as create —
    // otherwise the rotated credential is written with an empty client_id
    // that only fails later at handshake.
    const created = await createServer({
      namespace: "patchm2mnocid",
      auth_config: { kind: "oauth2_client_credentials", client_id: "cid-orig" },
      client_secret: "secret-orig",
    });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${created.id}`, {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        auth_config: { kind: "oauth2_client_credentials" },
        client_secret: "secret-rotated",
      }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("requires auth_config.client_id");
  });

  test("rejects an oauth2_private_key_jwt rotation missing algorithm (422)", async () => {
    const created = await createServer({
      namespace: "patchm2mnoalg",
      auth_config: { kind: "oauth2_private_key_jwt", client_id: "cid", algorithm: "RS256" },
      private_key: "-----BEGIN PRIVATE KEY-----\norig\n-----END PRIVATE KEY-----",
    });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${created.id}`, {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        auth_config: { kind: "oauth2_private_key_jwt", client_id: "cid" },
        private_key: "-----BEGIN PRIVATE KEY-----\nrot\n-----END PRIVATE KEY-----",
      }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("requires auth_config.algorithm");
  });
});

// ── POST /v1/mcp-servers/{id}/disable ────────────────────────────────────────

describe("POST /v1/mcp-servers/{id}/disable", () => {
  test("returns 403 for member", async () => {
    const row = await create(ctx.baseUrl, ctx.apiKey, "memberdisablens");
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}/disable`, {
      method: "POST",
      headers: memberAuth(),
    });
    expect(res.status).toBe(403);
  });

  test("disables a server and returns disabled status", async () => {
    const row = await createServer({ namespace: "disabletestns" });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}/disable`, {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("disabled");
  });

  test("returns 404 for unknown id", async () => {
    // Use a valid v4-format UUID that does not exist in the DB.
    const res = await fetch(
      `${ctx.baseUrl}/v1/mcp-servers/a0000000-0000-4000-8000-000000000077/disable`,
      { method: "POST", headers: adminAuth() },
    );
    expect(res.status).toBe(404);
  });
});

// ── POST /v1/mcp-servers/{id}/enable ─────────────────────────────────────────

describe("POST /v1/mcp-servers/{id}/enable", () => {
  test("re-enables a disabled server", async () => {
    const row = await createServer({ namespace: "enabletestns" });
    // First disable.
    await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}/disable`, {
      method: "POST",
      headers: adminAuth(),
    });
    // Then re-enable.
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}/enable`, {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("active");
  });
});

// ── DELETE /v1/mcp-servers/{id} ───────────────────────────────────────────────

describe("DELETE /v1/mcp-servers/{id}", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/00000000-0000-0000-0000-000000000001`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for member without mcp_server:manage", async () => {
    const row = await createServer({ namespace: "memberdelns" });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}`, {
      method: "DELETE",
      headers: memberAuth(),
    });
    expect(res.status).toBe(403);
  });

  test("returns 404 for unknown id", async () => {
    // Use a valid v4-format UUID that does not exist in the DB.
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/a0000000-0000-4000-8000-000000000066`, {
      method: "DELETE",
      headers: adminAuth(),
    });
    expect(res.status).toBe(404);
  });

  test("deletes a server and returns 204", async () => {
    const row = await createServer({ namespace: "deletehappyns" });
    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}`, {
      method: "DELETE",
      headers: adminAuth(),
    });
    expect(res.status).toBe(204);

    // Confirm gone.
    const gone = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${row.id}`, {
      headers: adminAuth(),
    });
    expect(gone.status).toBe(404);
  });
});

// ── tenant isolation ──────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  test("a second tenant's admin cannot read a server owned by the first tenant", async () => {
    // Create a server under the main test tenant (ctx.tenantId).
    const row = await createServer({ namespace: "isolatens" });

    // Spin up a separate test server with an independent tenant.
    const otherCtx = await createHttpTestServer("mcp-servers-tenant-b");
    try {
      // Attempt to GET the first tenant's server using tenant B's API key.
      const res = await fetch(`${otherCtx.baseUrl}/v1/mcp-servers/${row.id}`, {
        headers: { Authorization: `Bearer ${otherCtx.apiKey}` },
      });
      // Must be 404, not 200 (the server belongs to a different tenant).
      expect(res.status).toBe(404);
    } finally {
      await otherCtx.cleanup();
    }
  });
});

// ── helper for the disable test (avoids namespace collision) ─────────────────

async function create(baseUrl: string, apiKey: string, namespace: string): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/v1/mcp-servers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: `${namespace} MCP`,
      namespace,
      transport: "http",
      url: `https://${namespace}.mcp.test`,
    }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string }>;
}
