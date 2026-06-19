// Integration test: pool "needs authorization" behavior for oauth2 servers
// with no tokens.
//
// An oauth2 MCP server with no usable token must NOT crash the turn. The
// pool parks it in error status (backoff) after the transport raises
// UnauthorizedError on connect, and getTenantMcpTools returns only the
// healthy servers' tool sets. The failed server is absent from the result
// but the pool does not throw.
//
// INJECTION PATTERN: the pool's documented TEST SEAM
// (`__setMcpPoolFactoriesForTests`) swaps the SDK Client construction for an
// in-process fake — NO bun `mock.module` (module mocks are process-global
// and leak into every other test file in the same worker). The fake throws
// the REAL SDK `UnauthorizedError` for the oauth2 server (so the pool's
// `instanceof` mapping to "authorization required" is exercised for real);
// for the bearer server it returns tools normally. This covers the risk
// that a bad oauth2 server drags the whole turn down.
//
// SECRET-DISCIPLINE assertion: last_error stored for the failed server must
// not contain a URL with a query string (redact_safe check).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { closeDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  getTenantMcpTools,
  type McpClientLike,
} from "./pool.ts";
import { createMcpServer } from "./registry.ts";

// The factory seam hands the fake client its server row, so the fake can
// branch per server: the oauth2 server (namespace "oauth2server") fails its
// handshake with the SDK's real UnauthorizedError; the bearer server
// connects and lists one tool.
function makeFakeClient(namespace: string): McpClientLike {
  return {
    async connect() {
      if (namespace === "oauth2server") {
        // No usable token → the transport surfaces the SDK's typed error.
        throw new UnauthorizedError("no usable token");
      }
      // Bearer server: connect succeeds, no-op.
    },
    async listTools() {
      return {
        tools: [
          {
            name: "acme_tool",
            description: "A stub tool from the bearer server",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    },
    async callTool() {
      return { content: [], isError: false };
    },
    async close() {},
  };
}

// ── Test DB setup ─────────────────────────────────────────────────────────────

let ctx: TestDb;
let tenantId: string;

function auditCtx() {
  return {
    actor_id: "00000000-0000-0000-0000-000000000001",
    request_source: "api" as const,
    executor: ctx.db,
  };
}

// Keep the original DATABASE_URL so we can restore it in afterAll.
const _origDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: (row) => makeFakeClient(row.namespace) });
  ctx = await createTestDb("mcp-pool-needs-auth");

  // Pin DATABASE_URL + reset the global pool so getDb() inside pool.ts →
  // setMcpServerStatus → writeAudit (no executor passed by the pool) dials
  // the same isolated test database this suite owns. Without this the global
  // pool resolves to the default DATABASE_URL which has no test schema.
  await closeDb();
  process.env.DATABASE_URL = ctx.url;

  // The oauth2 handshake needs the canonical OAuth redirect URI
  // (`server.public_base_url`) to even construct its auth provider —
  // without it the pool parks the server BEFORE connect. The first suites
  // here exercise the UnauthorizedError-on-connect path, so configure a
  // public origin; the no-public-origin park has its own describe below.
  const cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-pool-needs-auth-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: ctx.url, NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  await setConfigKey("server.public_base_url", "https://engine.poolauth.example", { force: true });

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pool-auth", display_name: "Pool Auth Tenant" })
    .returning();
  tenantId = t!.id;
}, 30_000);

afterAll(async () => {
  // ALWAYS restore the seam (null-by-default protects production, but a
  // leaked non-null factory would still poison sibling test files).
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  _resetConfigForTests();

  // Close the global pool that was pointed at the test DB, then restore the
  // original DATABASE_URL so subsequent test files in this worker can dial
  // their own databases correctly.
  await closeDb();
  if (_origDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = _origDatabaseUrl;
  }

  await ctx.cleanup();
}, 30_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("pool: oauth2 server with no tokens is parked; bearer server still returned", () => {
  test("getTenantMcpTools skips the unauthorized oauth2 server and returns the bearer server's tools", async () => {
    __resetMcpClientPoolForTests();

    // Seed the oauth2 server — no credential row (no tokens).
    const oauth2Server = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantId,
        name: "AcmeAuth OAuth2 Server",
        namespace: "oauth2server",
        transport: "http",
        url: "https://oauth2server.acmeauth.test/mcp",
        auth_config: {
          kind: "oauth2",
          issuer: "https://auth.acmeauth.test",
        },
      },
      auditCtx(),
    );

    // Seed the bearer server WITH a credential row (healthy server).
    const bearerServer = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantId,
        name: "AcmeBearer Server",
        namespace: "bearerserver",
        transport: "http",
        url: "https://bearerserver.acmeauth.test/mcp",
        auth_config: { kind: "bearer" },
      },
      auditCtx(),
    );

    await upsertCredential(
      {
        tenant_id: tenantId,
        mcp_server_id: bearerServer.id,
        environment: "prod",
        mode: "bearer",
        value: { mode: "bearer", token: "bearer-token-abc" },
        actor_id: null,
        source: "oauth_callback",
      },
      ctx.db,
    );

    // getTenantMcpTools must NOT throw even though one server cannot connect.
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });

    // The bearer server's tools must be present.
    const bearerSet = sets.find((s) => s.mcp_server_id === bearerServer.id);
    expect(bearerSet).toBeDefined();
    expect(bearerSet!.tools.length).toBeGreaterThan(0);
    expect(bearerSet!.tools[0]!.name).toBe("acme_tool");

    // The oauth2 server must NOT be in the result set (it was parked).
    const oauth2Set = sets.find((s) => s.mcp_server_id === oauth2Server.id);
    expect(oauth2Set).toBeUndefined();
  });

  test("oauth2 server status is set to 'error' and last_error is redact-safe after UnauthorizedError", async () => {
    const { mcpServers } = await import("../../db/schema/index.ts");
    const rows = await ctx.db
      .select({ status: mcpServers.status, last_error: mcpServers.last_error })
      .from(mcpServers)
      .where(and(eq(mcpServers.tenant_id, tenantId), eq(mcpServers.namespace, "oauth2server")))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("error");

    // last_error must be redact-safe: no URL-with-query-string leakage.
    const lastError = rows[0]!.last_error ?? "";
    expect(lastError).not.toContain("?");
    // The pool maps UnauthorizedError → "authorization required" (no raw URL).
    expect(lastError).toContain("authorization");
  });
});

describe("pool: within backoff window the tokenless server stays absent", () => {
  test("second getTenantMcpTools call still skips the failed server (backoff not yet elapsed)", async () => {
    // Pool was NOT reset: the backoff entry from the previous test is still
    // armed. The bearer server is already cached (from the previous test).
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });

    // Bearer server is still present (cached from prior handshake).
    const bearerSet = sets.find((s) => s.namespace === "bearerserver");
    expect(bearerSet).toBeDefined();

    // OAuth2 server is still absent (inside backoff window).
    const oauth2Set = sets.find((s) => s.namespace === "oauth2server");
    expect(oauth2Set).toBeUndefined();
  });
});

// ── no public origin → oauth2 server parks BEFORE connect ────────────────────
//
// With no `server.public_base_url` there is no canonical OAuth redirect URI.
// A fallback derived from the server's own origin would DCR-register a
// redirect_uri the interactive /authorize route (which 400s in the same
// condition) can never use — a permanent redirect_uri_mismatch. The pool
// must instead park the server with a stable, redact-safe last_error.

describe("pool: oauth2 server with no public_base_url parks with a redirect-URI error", () => {
  test("getTenantMcpTools parks the server with the typed last_error and does not connect", async () => {
    // Clear the public origin so the canonical redirect URI cannot resolve.
    await setConfigKey("server.public_base_url", "", { force: true });
    __resetMcpClientPoolForTests();

    const server = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantId,
        name: "AcmeAuth No-Origin OAuth2 Server",
        namespace: "noorigin",
        transport: "http",
        url: "https://noorigin.acmeauth.test/mcp",
        auth_config: { kind: "oauth2", issuer: "https://auth.acmeauth.test" },
      },
      auditCtx(),
    );

    // Must not throw — the server is simply absent from the palette.
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(sets.find((s) => s.mcp_server_id === server.id)).toBeUndefined();

    const { mcpServers } = await import("../../db/schema/index.ts");
    const rows = await ctx.db
      .select({ status: mcpServers.status, last_error: mcpServers.last_error })
      .from(mcpServers)
      .where(and(eq(mcpServers.tenant_id, tenantId), eq(mcpServers.id, server.id)))
      .limit(1);
    expect(rows[0]!.status).toBe("error");
    const lastError = rows[0]!.last_error ?? "";
    expect(lastError).toContain("no canonical OAuth redirect URI");
    expect(lastError).toContain("server.public_base_url");
    // Redact-safe: never a URL with a query string.
    expect(lastError).not.toContain("?");
  });
});
