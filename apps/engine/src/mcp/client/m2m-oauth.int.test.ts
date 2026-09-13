// Integration tests: WS1 M2M OAuth — provider selection in connectClient
// via the __setMcpPoolFactoriesForTests seam, and secret-leak assertions
// against audit / last_error / structured log output.
//
// Layer: integration — real Postgres via createTestDb; no real token endpoint.
//
// INJECTION PATTERN: __setMcpPoolFactoriesForTests swaps the SDK Client
// construction for an in-process fake. The fake branches per server namespace:
//   - "m2m-cc-server"  (oauth2_client_credentials): connects and lists tools.
//   - "m2m-pk-server"  (oauth2_private_key_jwt):    connects and lists tools.
//   - "m2m-no-cred"    (oauth2_client_credentials): missing credential row →
//                       resolveAuthProvider throws before connect, so the pool
//                       parks the server in error+backoff without calling our
//                       fake's connect at all. We assert the error status and
//                       that no client_secret appears anywhere.
//
// NO real LLM, NO real token endpoint, NO MSW. The credential resolution path
// (getOAuth2ClientCredentialForMcpServer / getOAuth2PrivateKeyCredentialForMcpServer)
// reads from the real encrypted DB; the transport + SDK Client are swapped.
//
// Secret-by-reference assertion: client_secret / private_key must NEVER appear
// in connectors.last_error or in the audit_log.metadata blob.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { closeDb } from "../../db/client.ts";
import { auditLog, connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  getTenantMcpTools,
  type McpClientLike,
} from "./pool.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

// ── Fake client ───────────────────────────────────────────────────────────────
// Branches per server slug: healthy M2M servers connect and list tools;
// the "no-cred" server is never reached (resolveAuthProvider throws first).

function makeFakeM2mClient(slug: string): McpClientLike {
  return {
    async connect() {
      // M2M servers (credential present): connect is a no-op (provider
      // fetches the token; the fake doesn't simulate that leg).
    },
    async listTools() {
      return {
        tools: [
          {
            name: `${slug}_tool`,
            description: `A tool from ${slug}`,
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    },
    async callTool() {
      return { content: [], isError: false };
    },
    async readResource() {
      return { contents: [] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    async close() {},
  };
}

// ── Test DB setup ─────────────────────────────────────────────────────────────

let ctx: TestDb;
let tenantId: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({
    makeClient: (row) => makeFakeM2mClient(row.slug),
  });

  ctx = await createTestDb("mcp-m2m-oauth");

  // Point the process-global DB pool at the isolated test database so
  // pool.ts → setMcpServerStatus → writeAudit (no executor) resolves to
  // the same isolated schema this suite owns.
  await closeDb();
  process.env.DATABASE_URL = ctx.url;

  // M2M kinds do NOT use the OAuth redirect URI path (no interactive flow,
  // no oauthRedirectUriFor call), so any public_base_url value is fine; set
  // one anyway to keep the pool's oauth2 guard path satisfied for the
  // adjacent server variants.
  const cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-m2m-oauth-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: ctx.url, NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  await setConfigKey("server.public_base_url", "https://engine.m2m-oauth.example", {
    force: true,
  });

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-m2m-oauth", display_name: "M2M OAuth Tenant" })
    .returning();
  tenantId = t!.id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  _resetConfigForTests();

  await closeDb();
  if (_origDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = _origDatabaseUrl;
  }

  await ctx.cleanup();
}, 30_000);

// ── oauth2_client_credentials: happy path ────────────────────────────────────

describe("pool: oauth2_client_credentials server with credential row", () => {
  test("getTenantMcpTools returns the server's tools when credential is present", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "m2m-cc-server",
      transport: "http",
      url: "https://m2m-cc.mcp-test.example.com",
      auth: {
        kind: "oauth2_client_credentials",
        client_id: "cc-client-001",
        scope: "tools:read",
      },
    });

    // Write the client_secret into the encrypted credentials table under
    // the oauth2_client mode (same slot the route handler uses).
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: server.id,
        environment: "prod",
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          client_id: "cc-client-001",
          client_secret: "super-secret-value-never-logged",
        },
        actor_id: null,
        source: "http_route",
      },
      ctx.db,
    );

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const found = sets.find((s) => s.connector_id === server.id);
    expect(found).toBeDefined();
    expect(found!.tools.length).toBeGreaterThan(0);
    expect(found!.tools[0]!.name).toBe("m2m-cc-server_tool");
    expect(found!.slug).toBe("m2m-cc-server");
  });

  test("secret is not persisted in the connector config (non-secret shape only)", async () => {
    const row = await ctx.db
      .select({ config: connectors.config })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-cc-server")))
      .limit(1);
    const cfg = (row[0]?.config as { mcp?: { auth?: unknown } } | undefined)?.mcp?.auth;
    const cfgJson = JSON.stringify(cfg ?? {});
    expect(cfgJson).not.toContain("super-secret-value-never-logged");
    expect(cfgJson).not.toContain("client_secret");
    expect(cfgJson).toContain("oauth2_client_credentials");
    expect(cfgJson).toContain("cc-client-001");
  });

  test("connector health stays ok after a successful handshake", async () => {
    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-cc-server")));
    expect(rows[0]?.health_state).toBe("ok");
    expect(rows[0]?.last_error).toBeNull();
  });

  test("audit log contains connector.mcp_handshake_ok and no secret material", async () => {
    const rows = await ctx.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, tenantId));
    const allMetaJson = rows.map((r) => JSON.stringify(r.metadata ?? {})).join("\n");
    // No secret may appear in any audit row.
    expect(allMetaJson).not.toContain("super-secret-value-never-logged");
    expect(allMetaJson).not.toContain("client_secret");
    expect(allMetaJson).not.toContain("private_key");

    const actions = rows.map((r) => r.action);
    expect(actions).toContain("connector.mcp_handshake_ok");
  });
});

// ── oauth2_private_key_jwt: happy path ───────────────────────────────────────

describe("pool: oauth2_private_key_jwt server with credential row", () => {
  test("getTenantMcpTools returns the server's tools when private key credential is present", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "m2m-pk-server",
      transport: "http",
      url: "https://m2m-pk.mcp-test.example.com",
      auth: {
        kind: "oauth2_private_key_jwt",
        client_id: "pk-client-002",
        algorithm: "RS256",
        scope: "mcp:invoke",
      },
    });

    // Store private key in the dedicated oauth2_private_key credential slot.
    // Using a synthetic PEM placeholder — the fake client never calls
    // PrivateKeyJwtProvider.getToken() (connect() is a no-op in the seam).
    const fakePem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4SbCQSbpFKEUBpFVBfvVNJL1",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: server.id,
        environment: "prod",
        mode: "oauth2_private_key",
        value: {
          mode: "oauth2_private_key",
          client_id: "pk-client-002",
          private_key: fakePem,
          algorithm: "RS256",
        },
        actor_id: null,
        source: "http_route",
      },
      ctx.db,
    );

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const found = sets.find((s) => s.connector_id === server.id);
    expect(found).toBeDefined();
    expect(found!.tools.length).toBeGreaterThan(0);
    expect(found!.tools[0]!.name).toBe("m2m-pk-server_tool");
  });

  test("private key VALUE is NOT persisted in the connector config", async () => {
    const row = await ctx.db
      .select({ config: connectors.config })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-pk-server")))
      .limit(1);
    const cfgJson = JSON.stringify(
      (row[0]?.config as { mcp?: { auth?: unknown } } | undefined)?.mcp?.auth ?? {},
    );
    // The PEM key value must never appear in the non-secret auth block.
    // We check for distinctive PEM content, not the field NAME (which legitimately
    // appears as the auth kind string "oauth2_private_key_jwt").
    expect(cfgJson).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(cfgJson).not.toContain("MIIEowIBAAKCAQEA");
    // Non-secret fields ARE present.
    expect(cfgJson).toContain("oauth2_private_key_jwt");
    expect(cfgJson).toContain("pk-client-002");
    expect(cfgJson).toContain("RS256");
  });

  test("private key VALUE is NOT present in any audit row", async () => {
    const rows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, tenantId));
    const allMetaJson = rows.map((r) => JSON.stringify(r.metadata ?? {})).join("\n");
    // The PEM key material must never appear in audit metadata.
    // Note: "oauth2_private_key" as a credential mode NAME legitimately appears
    // in credential.created audit metadata — that's the correct, safe behaviour.
    // We assert the actual PEM content is absent.
    expect(allMetaJson).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(allMetaJson).not.toContain("MIIEowIBAAKCAQEA");
  });
});

// ── Missing credential → park in error, no secret in last_error ──────────────

describe("pool: oauth2_client_credentials server with no credential row", () => {
  test("getTenantMcpTools parks the server in error status without throwing", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "m2m-no-cred",
      transport: "http",
      url: "https://m2m-no-cred.mcp-test.example.com",
      auth: {
        kind: "oauth2_client_credentials",
        client_id: "no-cred-client",
      },
    });
    // Intentionally no credential row — simulates an operator who created the
    // MCP server definition but hasn't provided the secret yet.

    // Must NOT throw; server is silently absent from the palette.
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const found = sets.find((s) => s.connector_id === server.id);
    expect(found).toBeUndefined();

    // The connector must be parked degraded with the failure text.
    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, server.id)))
      .limit(1);
    expect(rows[0]?.health_state).toBe("degraded");

    // last_error is a diagnostic message, not an echoed secret value.
    // The message may contain words like "client_secret" as a NOUN (telling
    // the operator what to provide), but must never contain an actual secret
    // VALUE (token, PEM key, query string, etc.).
    const lastError = rows[0]?.last_error ?? "";
    expect(lastError.length).toBeGreaterThan(0);
    // No URL with a query string (which could carry a leaked token).
    expect(lastError).not.toContain("?");
    // No PEM-encoded key material.
    expect(lastError).not.toContain("BEGIN");
    // No bearer token or base64 secret patterns.
    expect(lastError).not.toMatch(/Bearer\s+\S{20,}/);
    // The actual client_secret VALUE we would have stored is absent.
    // (The word "client_secret" as a noun in the diagnostic is allowed.)
    expect(lastError).not.toContain("super-secret-value-never-logged");
  });

  test("last_error describes the missing credential, not a secret value", async () => {
    const rows = await ctx.db
      .select({ last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-no-cred")))
      .limit(1);
    // The error must mention the credential requirement, not expose a secret.
    const lastError = rows[0]?.last_error ?? "";
    expect(lastError.length).toBeGreaterThan(0);
    // The pool's error message says "has no client credential" — verify it
    // is the human-readable diagnostic, not an echoed secret or URL with a token.
    expect(lastError.toLowerCase()).toMatch(/credential|client|register/);
  });
});

// ── Missing private key credential → park in error ───────────────────────────

describe("pool: oauth2_private_key_jwt server with no credential row", () => {
  test("getTenantMcpTools parks the server and last_error is redact-safe", async () => {
    __resetMcpClientPoolForTests();

    const server = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "m2m-no-key",
      transport: "http",
      url: "https://m2m-no-key.mcp-test.example.com",
      auth: {
        kind: "oauth2_private_key_jwt",
        client_id: "no-key-client",
        algorithm: "ES256",
      },
    });
    // No credential row for the private key.

    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(sets.find((s) => s.connector_id === server.id)).toBeUndefined();

    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, server.id)))
      .limit(1);
    expect(rows[0]?.health_state).toBe("degraded");

    const lastError = rows[0]?.last_error ?? "";
    expect(lastError.length).toBeGreaterThan(0);
    // No PEM key VALUE.
    expect(lastError).not.toContain("BEGIN RSA");
    expect(lastError).not.toContain("MIIEowIBAAKCAQEA");
    // No URL with a query string.
    expect(lastError).not.toContain("?");
    // The error is a human-readable diagnostic (may use "private_key" as a noun).
    expect(lastError.toLowerCase()).toMatch(/credential|private key|private_key|register/);
  });
});

// ── Tenant isolation: wrong tenant cannot reach another tenant's M2M server ──

describe("pool: tenant isolation for M2M credential resolution", () => {
  test("tenant B cannot access tenant A's oauth2_client_credentials server", async () => {
    __resetMcpClientPoolForTests();

    // Seed a second tenant.
    const [tB] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-m2m-b", display_name: "M2M Tenant B" })
      .returning();
    const tenantBId = tB!.id;

    // Seed a server + credential for tenant A.
    const serverA = await seedMcpConnector(ctx.db, {
      tenant_id: tenantId,
      slug: "tenant-a-m2m",
      transport: "http",
      url: "https://tenant-a-m2m.mcp-test.example.com",
      auth: {
        kind: "oauth2_client_credentials",
        client_id: "a-client",
      },
    });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: serverA.id,
        environment: "prod",
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          client_id: "a-client",
          client_secret: "tenant-a-secret",
        },
        actor_id: null,
        source: "http_route",
      },
      ctx.db,
    );

    // Tenant B's tool listing must return an empty set — it has no
    // registered MCP servers, so it cannot reach tenant A's server at all.
    const bSets = await getTenantMcpTools(ctx.db, tenantBId, { environment: "prod" });
    expect(bSets.find((s) => s.connector_id === serverA.id)).toBeUndefined();

    // Tenant A's server is still accessible to tenant A.
    const aSets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(aSets.find((s) => s.connector_id === serverA.id)).toBeDefined();
  });
});

// ── resolveAuthHeaders returns {} for M2M kinds (no static Authorization header)

describe("pool: M2M kinds do not generate a static Authorization header", () => {
  test("oauth2_client_credentials server listed via getTenantMcpTools without a static bearer header", async () => {
    // This is a structural assertion: the pool must not attempt to read a
    // bearer/basic credential for M2M kinds. The fake client connects
    // unconditionally, so if resolveAuthHeaders tried to find a non-existent
    // bearer credential for these kinds it would throw before connect.
    // (The credential row for "m2m-cc-server" is an oauth2_client row, not bearer.)
    //
    // Verified by the happy-path test above: if resolveAuthHeaders were to
    // attempt getCredentialForConnector for the m2m kind and find only the
    // oauth2_client row (wrong mode for bearer lookup), it would throw
    // "credential does not exist" — which does NOT happen.
    //
    // We assert this indirectly: the connector must be healthy with no
    // parked failure text, which only happens when connect succeeds
    // (= resolveAuthHeaders did not throw).
    const rows = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.slug, "m2m-cc-server")));
    expect(rows[0]?.health_state).toBe("ok");
    expect(rows[0]?.last_error).toBeNull();
  });
});
