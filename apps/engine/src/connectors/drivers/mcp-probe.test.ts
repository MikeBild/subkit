// The mcp connector probe.
//
// The probe drives the pool's own connect path rather than opening a
// throwaway session, so what these tests exercise is what a real call
// exercises. They assert the two things a probe is for: it reports the
// remote's tool count when the handshake succeeds, and it reports a code
// the caller can branch on when it does not — distinguishing "no session
// is registered", "an operator disabled it" and "the remote refused".
//
// INJECTION PATTERN: the pool's documented TEST SEAM
// (`__setMcpPoolFactoriesForTests`) swaps SDK Client construction for an
// in-process fake. NO bun `mock.module` — module mocks are process-global
// and leak into every other test file in the same worker.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { closeDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { setConnectorEnabled } from "../service.ts";
import type { ConnectorView } from "../types.ts";
import { probeMcpConnector } from "./mcp.ts";

// Hosts whose fake client refuses the handshake, so a test can express a
// failing remote without a network.
const REFUSING_HOSTS = new Set<string>();

function makeFakeClient(url: string): McpClientLike {
  return {
    async connect() {
      if (REFUSING_HOSTS.has(new URL(url).host)) {
        throw new Error("401 Unauthorized from the remote");
      }
    },
    async listTools() {
      return {
        tools: [
          { name: "search", description: "search", inputSchema: { type: "object" } },
          { name: "fetch", description: "fetch", inputSchema: { type: "object" } },
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

let ctx: TestDb;
let tenantId: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

/**
 * Build the connector the probe sees.
 *
 * `id` is the load-bearing field: the pool addresses a session by the
 * connector's own id, so the view a probe is handed must carry the id of
 * the row the driver will look up.
 */
function connectorView(p: {
  id: string;
  slug: string;
  base_url: string;
  config?: Record<string, unknown>;
  auth_type?: ConnectorView["auth_type"];
}): ConnectorView {
  return {
    id: p.id,
    tenant_id: tenantId,
    slug: p.slug,
    display_name: p.slug,
    driver: "mcp",
    environment: "prod",
    auth_type: p.auth_type ?? "none",
    base_url: p.base_url,
    dsn: null,
    config: p.config ?? { mcp: { transport: "http" } },
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    self_description: {},
    // Fixed instants: this fixture only needs the columns to be dates, and a
    // wall-clock read here makes the suite non-reproducible for no benefit.
    created_at: new Date(0),
    updated_at: new Date(0),
    enabled: true,
    last_error: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 300_000,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    health_state: "ok",
    health_reason: null,
    health_error_code: null,
    sunset_at: null,
    successor_uri: null,
  };
}

async function seedSession(slug: string, host: string): Promise<{ id: string; url: string }> {
  const url = `https://${host}.mcpprobetest.example.com/mcp`;
  const row = await seedMcpConnector(ctx.db, { tenant_id: tenantId, slug, transport: "http", url });
  return { id: row.id, url };
}

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: (row) => makeFakeClient(row.url) });
  ctx = await createTestDb("mcp-driver-probe");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-mcp-probe", display_name: "MCP Probe Tenant" })
    .returning();
  tenantId = t!.id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("probeMcpConnector", () => {
  test("a successful handshake reports the remote's tool count and no HTTP status", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("probeok", "alpha");
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: connectorView({ id: seeded.id, slug: "probeok", base_url: seeded.url }),
      requestSource: "api",
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("2 tool(s)");
    // An MCP handshake has no HTTP status; inventing one would make the
    // probe response lie about what was observed.
    expect(res.status).toBeUndefined();
    expect(res.error_code).toBeUndefined();
  });

  test("a refused handshake reports credential_invalid, not a generic failure", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("probe401", "bravo");
    REFUSING_HOSTS.add(new URL(seeded.url).host);
    try {
      const res = await probeMcpConnector({
        db: ctx.db,
        tenant_id: tenantId,
        connector: connectorView({ id: seeded.id, slug: "probe401", base_url: seeded.url }),
        requestSource: "api",
      });
      expect(res.ok).toBe(false);
      expect(res.error_code).toBe("credential_invalid");
      expect(res.detail).toContain("401");
    } finally {
      REFUSING_HOSTS.delete(new URL(seeded.url).host);
    }
  });

  test("the failure detail carries no URL — probe output is operator-facing", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("probredact", "charlie");
    REFUSING_HOSTS.add(new URL(seeded.url).host);
    try {
      const res = await probeMcpConnector({
        db: ctx.db,
        tenant_id: tenantId,
        connector: connectorView({ id: seeded.id, slug: "probredact", base_url: seeded.url }),
        requestSource: "api",
      });
      expect(res.detail ?? "").not.toContain("/mcp");
    } finally {
      REFUSING_HOSTS.delete(new URL(seeded.url).host);
    }
  });

  test("a disabled server is distinguished from a missing one", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("probedis", "delta");
    await setConnectorEnabled(tenantId, seeded.id, false, null, ctx.db);
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: connectorView({ id: seeded.id, slug: "probedis", base_url: seeded.url }),
      requestSource: "api",
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("disabled");
    // Not `unknown_upstream_error`: no request left the host, so a reader who
    // branches on the code must not be sent to investigate the remote.
    expect(res.error_code).toBe("connector_disabled");

    const missing = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: connectorView({
        id: "00000000-0000-0000-0000-0000000000aa",
        slug: "probemissing",
        base_url: "https://echo.mcpprobetest.example.com/mcp",
      }),
      requestSource: "api",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error_code).toBe("remote_resource_not_found");
    expect(missing.detail).not.toContain("disabled");
  });

  test("a credential override authenticates a throwaway handshake", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("probeover", "foxtrot");
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: connectorView({
        id: seeded.id,
        slug: "probeover",
        base_url: seeded.url,
        auth_type: "bearer",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
      }),
      credential_override: { mode: "bearer", token: "probe-only" },
      requestSource: "api",
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("2 tool(s)");
  });

  test("a mismatched override is rejected before the handshake", async () => {
    const seeded = await seedSession("probeswrong", "foxtrot-wrong");
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: connectorView({
        id: seeded.id,
        slug: "probeswrong",
        base_url: seeded.url,
        auth_type: "bearer",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
      }),
      credential_override: { mode: "basic", username: "u", password: "p" },
      requestSource: "api",
    });
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe("credential_invalid");
    expect(res.detail).toContain("expected bearer credential");
  });

  test("an unserved transport fails before any handshake is attempted", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("probesse", "golf");
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: connectorView({
        id: seeded.id,
        slug: "probesse",
        base_url: seeded.url,
        config: { mcp: { transport: "sse" } },
      }),
      requestSource: "api",
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("streamable HTTP");
  });

  test("a config the driver cannot read fails with the offending field named", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("probebad", "hotel");
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: connectorView({
        id: seeded.id,
        slug: "probebad",
        base_url: seeded.url,
        config: { mcp: { transport: "http", nonsense: true } },
      }),
      requestSource: "api",
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("nonsense");
  });
});
