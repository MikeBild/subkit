// Integration test: a mid-session 401 from a remote tool call invalidates
// the oauth2 token credential so the next handshake re-authorizes instead of
// replaying the dead token forever (#171 follow-up, fix #4).
//
// The SDK Client is mocked: connect() succeeds, listTools() returns one tool,
// and callTool() throws an UnauthorizedError to simulate a token the IdP
// revoked mid-session. The pool must:
//   - surface a tool error (never throw out of the turn),
//   - evict the cached client,
//   - DELETE the oauth2 token credential for that tenant/server.
//
// MOCK PATTERN matches pool-needs-auth.test.ts: mock.module() before the
// dynamic import of pool.ts so the pool resolves the stubbed SDK.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import { closeDb } from "../../db/client.ts";
import { credentials, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMcpServer } from "./registry.ts";

const realSdkIndex = await import("@modelcontextprotocol/sdk/client/index.js");
const realSdkAuth = await import("@modelcontextprotocol/sdk/client/auth.js");
const realSdkStreamableHttp = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

class StubUnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

// The pool calls `new StreamableHTTPClientTransport(url, opts)`; the stub
// ignores both args. No constructor needed.
class StubStreamableHTTPTransport {}

class StubClient {
  async connect(_transport: unknown): Promise<void> {
    // Connect succeeds — there IS a (now stale) token at connect time.
  }
  async listTools() {
    return {
      tools: [
        {
          name: "acme_tool",
          description: "stub",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  }
  async callTool(): Promise<never> {
    // The IdP revoked the token mid-session → 401 on the actual call.
    throw new StubUnauthorizedError("401 Unauthorized");
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

const { invokeRemoteTool, __resetMcpClientPoolForTests } = await import("./pool.ts");

let ctx: TestDb;
let tenantId: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

// Deterministic, wall-clock-free "token still valid" expiry. The pooled
// connect replays this credential only while it's unexpired vs the REAL db
// `now()`, so a fixed far-future absolute instant keeps it valid without
// reading the wall clock.
const TOKEN_VALID_UNTIL = new Date("2999-01-01T00:00:00.000Z");

function auditCtx() {
  return {
    actor_id: "00000000-0000-0000-0000-000000000001",
    request_source: "api" as const,
    executor: ctx.db,
  };
}

beforeAll(async () => {
  ctx = await createTestDb("mcp-pool-invoke-401");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pool-401", display_name: "Pool 401 Tenant" })
    .returning();
  tenantId = t!.id;
}, 30_000);

afterAll(async () => {
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  mock.module("@modelcontextprotocol/sdk/client/index.js", () => realSdkIndex);
  mock.module("@modelcontextprotocol/sdk/client/auth.js", () => realSdkAuth);
  mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => realSdkStreamableHttp);
  await ctx.cleanup();
}, 30_000);

describe("pool: mid-session 401 invalidates the oauth2 token credential", () => {
  test("callTool 401 → tool error + the oauth2 token row is deleted", async () => {
    __resetMcpClientPoolForTests();

    const server = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantId,
        name: "AcmeAuth OAuth2 401 Server",
        namespace: "oauth401server",
        transport: "http",
        url: "https://oauth401server.acmeauth.test/mcp",
        auth_config: { kind: "oauth2", issuer: "https://auth.acmeauth.test" },
      },
      auditCtx(),
    );

    // Seed an oauth2 token credential so connect() can replay it (the IdP
    // then 401s on the actual tool call).
    await upsertCredential(
      {
        tenant_id: tenantId,
        mcp_server_id: server.id,
        environment: "prod",
        mode: "oauth2",
        value: { mode: "oauth2", access_token: "stale-access-token", token_type: "Bearer" },
        oauth2_refresh_token: null,
        oauth2_expires_at: TOKEN_VALID_UNTIL,
        actor_id: null,
        source: "oauth_callback",
      },
      ctx.db,
    );

    const tokenRowsBefore = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantId),
          eq(credentials.mcp_server_id, server.id),
          eq(credentials.mode, "oauth2"),
        ),
      );
    expect(tokenRowsBefore.length).toBe(1);

    const res = await invokeRemoteTool({
      db: ctx.db,
      tenant_id: tenantId,
      mcp_server_id: server.id,
      namespace: "oauth401server",
      remote_tool: "acme_tool",
      input: {},
      environment: "prod",
    });

    // The turn must not crash — a tool error is returned.
    expect(res.ok).toBe(false);

    // The dead oauth2 token credential must have been invalidated so the next
    // handshake re-authorizes instead of looping on the same stale token.
    const tokenRowsAfter = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenantId),
          eq(credentials.mcp_server_id, server.id),
          eq(credentials.mode, "oauth2"),
        ),
      );
    expect(tokenRowsAfter.length).toBe(0);
  });
});
