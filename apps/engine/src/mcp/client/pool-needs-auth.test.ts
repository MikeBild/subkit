// Integration test: pool "needs authorization" behavior for oauth2 servers
// with no tokens (#171 follow-up).
//
// An oauth2 MCP server with no usable token must NOT crash the turn. The
// pool parks it in error status (backoff) after the SDK transport raises
// UnauthorizedError on connect, and getTenantMcpTools returns only the
// healthy servers' tool sets. The failed server is absent from the result
// but the pool does not throw.
//
// The SDK Client.connect() is mocked so no real MCP server is needed.
// For the oauth2 server the mock throws UnauthorizedError; for the bearer
// server it returns tools normally. This covers the risk that a bad oauth2
// server drags the whole turn down.
//
// SECRET-DISCIPLINE assertion: last_error stored for the failed server must
// not contain a URL with a query string (redact_safe check).
//
// MOCK PATTERN: mock.module() calls run BEFORE the dynamic import of pool.ts
// so the pool module resolves the stubbed SDK when it first loads. Static
// import declarations are hoisted; dynamic await import() is not.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import { closeDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMcpServer } from "./registry.ts";

// ── SDK Client mock ───────────────────────────────────────────────────────────
//
// The pool constructs `new Client(...)` from the SDK, then calls
// `client.connect(transport)`. We intercept at the SDK Client level.
//
// Capture originals before mocking so we can restore in afterAll.
const realSdkIndex = await import("@modelcontextprotocol/sdk/client/index.js");
const realSdkAuth = await import("@modelcontextprotocol/sdk/client/auth.js");
const realSdkStreamableHttp = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

class StubUnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

// Track which server URL the active stub transport targets. The pool
// constructs a new transport per connect attempt, so this cell always
// reflects the most recent attempt — and our tests run serially.
let activeTransportUrl = "";

class StubStreamableHTTPTransport {
  #url: URL;
  constructor(url: URL) {
    this.#url = url;
    activeTransportUrl = url.toString();
  }
}

class StubClient {
  async connect(_transport: unknown): Promise<void> {
    // Throw for the oauth2 server (no token → UnauthorizedError).
    if (activeTransportUrl.includes("oauth2server")) {
      throw new StubUnauthorizedError("no usable token");
    }
    // Bearer server: connect succeeds, no-op.
  }
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
  }
  async close(): Promise<void> {}
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  ...realSdkIndex,
  Client: StubClient,
}));

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  ...realSdkAuth,
  UnauthorizedError: StubUnauthorizedError,
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  ...realSdkStreamableHttp,
  StreamableHTTPClientTransport: StubStreamableHTTPTransport,
}));

// Dynamic import AFTER mocks: pool.ts resolves the stubbed SDK on first load.
const { getTenantMcpTools, __resetMcpClientPoolForTests } = await import("./pool.ts");

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
  ctx = await createTestDb("mcp-pool-needs-auth");

  // Pin DATABASE_URL + reset the global pool so getDb() inside pool.ts →
  // setMcpServerStatus → writeAudit (no executor passed by the pool) dials
  // the same isolated test database this suite owns. Without this the global
  // pool resolves to the default DATABASE_URL which has no test schema.
  await closeDb();
  process.env.DATABASE_URL = ctx.url;

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pool-auth", display_name: "Pool Auth Tenant" })
    .returning();
  tenantId = t!.id;
}, 30_000);

afterAll(async () => {
  // Close the global pool that was pointed at the test DB, then restore the
  // original DATABASE_URL so subsequent test files in this worker can dial
  // their own databases correctly.
  await closeDb();
  if (_origDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = _origDatabaseUrl;
  }

  // Restore SDK modules.
  mock.module("@modelcontextprotocol/sdk/client/index.js", () => realSdkIndex);
  mock.module("@modelcontextprotocol/sdk/client/auth.js", () => realSdkAuth);
  mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => realSdkStreamableHttp);

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
