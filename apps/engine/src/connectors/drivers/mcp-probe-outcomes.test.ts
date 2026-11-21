import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { closeDb } from "../../db/client.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { _resetLoggerForTests, reconfigureLogger } from "../../logging/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { setConnectorEnabled } from "../service.ts";
import { probeMcpConnector } from "./mcp.ts";
import {
  CONNECT_FAILURES,
  captureNdjsonLogs,
  makeProbeClient,
  mcpConnectorView,
  PROBE_TOOLS,
} from "./mcp-probe-fixtures.ts";

const LATENCY_CEILING_MS = 60_000;

let ctx: TestDb;
let tenantId: string;
const originalDatabaseUrl = testEnv.DATABASE_URL;

async function seedSession(slug: string): Promise<{ id: string; url: string; host: string }> {
  const host = `${slug}.mcpprobeoutcome.example.com`;
  const url = `https://${host}/mcp`;
  const row = await seedMcpConnector(ctx.db, { tenant_id: tenantId, slug, transport: "http", url });
  return { id: row.id, url, host };
}

async function probeSeeded(slug: string, failure?: string) {
  __resetMcpClientPoolForTests();
  const seeded = await seedSession(slug);
  if (failure !== undefined) CONNECT_FAILURES.set(seeded.host, failure);
  try {
    return await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: seeded.id,
        slug,
        base_url: seeded.url,
      }),
      requestSource: "api",
    });
  } finally {
    CONNECT_FAILURES.delete(seeded.host);
  }
}

function expectSaneLatency(latency_ms: number): void {
  expect(latency_ms).toBeGreaterThanOrEqual(0);
  expect(latency_ms).toBeLessThan(LATENCY_CEILING_MS);
}

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: (row) => makeProbeClient(row.url) });
  ctx = await createTestDb("mcp-driver-probe-outcomes");
  await closeDb();
  testEnv.DATABASE_URL = ctx.url;
  tenantId = (await seedTenant(ctx.db, { slug: "t-mcp-outcome", display_name: "MCP Outcome" })).id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (originalDatabaseUrl === undefined) delete testEnv.DATABASE_URL;
  else testEnv.DATABASE_URL = originalDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("probeMcpConnector over a registered session", () => {
  test("a successful handshake reports the tool count with a measured latency", async () => {
    const res = await probeSeeded("outok");
    expect(res).toMatchObject({ ok: true, detail: "handshake ok — 2 tool(s)" });
    expectSaneLatency(res.latency_ms);
  });

  test("the handshake audit row names the caller's request source", async () => {
    await probeSeeded("outsource");
    const rows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "connector.mcp_handshake_ok")),
      );
    const sources = rows
      .map((r) => r.metadata as { request_source?: string; connector_slug?: string })
      .filter((m) => m.connector_slug === "outsource")
      .map((m) => m.request_source);
    expect(sources).toEqual(["api"]);
  });

  test("a handshake refused for a missing client credential reports credential_missing", async () => {
    const res = await probeSeeded("outnocred", "no client credential configured for this server");
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe("credential_missing");
    expect(res.detail).toBe("no client credential configured for this server");
    expectSaneLatency(res.latency_ms);
  });

  test("a handshake that fails without an auth hint reports an upstream error with the cause", async () => {
    const res = await probeSeeded("outreset", "socket hang up");
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe("unknown_upstream_error");
    expect(res.detail).toBe("socket hang up");
  });

  test("a handshake answered with unauthorized reports credential_invalid", async () => {
    const res = await probeSeeded("outunauth", "server said Unauthorized");
    expect(res.error_code).toBe("credential_invalid");
  });

  test("a missing session names the missing registration", async () => {
    __resetMcpClientPoolForTests();
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: "00000000-0000-4000-8000-0000000000ab",
        slug: "outmissing",
        base_url: "https://outmissing.mcpprobeoutcome.example.com/mcp",
      }),
    });
    expect(res).toMatchObject({
      ok: false,
      detail: "no MCP session is registered for this connector",
      error_code: "remote_resource_not_found",
    });
    expectSaneLatency(res.latency_ms);
  });

  test("a disabled session tells the operator to enable it first", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("outdisabled");
    await setConnectorEnabled(tenantId, seeded.id, false, null, ctx.db);
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: seeded.id,
        slug: "outdisabled",
        base_url: seeded.url,
      }),
    });
    expect(res).toMatchObject({
      ok: false,
      detail: "this MCP server is disabled — enable it before probing",
      error_code: "connector_disabled",
    });
  });

  test("a session registered for another tenant is not found from this one", async () => {
    __resetMcpClientPoolForTests();
    const other = await seedTenant(ctx.db, { slug: "t-mcp-outcome-b", display_name: "Other" });
    const seeded = await seedSession("outforeign");
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: other.id,
      connector: mcpConnectorView({
        tenant_id: other.id,
        id: seeded.id,
        slug: "outforeign",
        base_url: seeded.url,
      }),
    });
    expect(res.error_code).toBe("remote_resource_not_found");
  });

  test("a connector id the database rejects fails as an upstream error instead of throwing", async () => {
    __resetMcpClientPoolForTests();
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: "not-a-uuid",
        slug: "outbadid",
        base_url: "https://outbadid.mcpprobeoutcome.example.com/mcp",
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe("unknown_upstream_error");
    expect((res.detail ?? "").length).toBeGreaterThan(0);
    expectSaneLatency(res.latency_ms);
  });
});

describe("probeMcpConnector configuration refusals", () => {
  test("every unreadable config field is named in the detail", async () => {
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: "00000000-0000-4000-8000-0000000000ac",
        slug: "outbadcfg",
        base_url: null,
        config: { mcp: { transport: "carrier-pigeon" } },
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe("unknown_upstream_error");
    expect(
      res.detail?.startsWith("invalid mcp connector config for outbadcfg: mcp.transport: "),
    ).toBe(true);
    expectSaneLatency(res.latency_ms);
  });

  test("two unreadable fields are listed separately", async () => {
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: "00000000-0000-4000-8000-0000000000ad",
        slug: "outtwobad",
        base_url: null,
        config: { mcp: { transport: "carrier-pigeon", remote_tool_call_timeout_ms: "soon" } },
      }),
    });
    expect(res.detail?.split("; ")).toHaveLength(2);
  });

  test("an sse transport is refused as not served with an upstream error code", async () => {
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: "00000000-0000-4000-8000-0000000000ae",
        slug: "outsse",
        base_url: null,
        config: { mcp: { transport: "sse" } },
      }),
    });
    expect(res).toMatchObject({
      ok: false,
      detail: "mcp transport 'sse' is not served — re-register this connector over streamable HTTP",
      error_code: "unknown_upstream_error",
    });
    expectSaneLatency(res.latency_ms);
  });
});

describe("probeMcpConnector override probes", () => {
  test("a successful override probe returns the remote manifest", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("ovmanifest");
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: seeded.id,
        slug: "ovmanifest",
        base_url: seeded.url,
      }),
      credential_override: null,
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toBe("handshake ok — 2 tool(s)");
    expect(res.manifest?.instructions).toBe("use search first");
    expect(res.manifest?.tools.map((t) => t.name).sort()).toEqual(
      PROBE_TOOLS.map((t) => t.name).sort(),
    );
    expectSaneLatency(res.latency_ms);
  });

  test("an override probe without a credential for a bearer server reports credential_missing", async () => {
    const seeded = await seedSession("ovnocred");
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: seeded.id,
        slug: "ovnocred",
        base_url: seeded.url,
        auth_type: "bearer",
        config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
      }),
      credential_override: null,
    });
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe("credential_missing");
    expect(res.detail).toContain("requires a credential");
    expectSaneLatency(res.latency_ms);
  });

  test("an override probe refused upstream with 401 reports credential_invalid", async () => {
    __resetMcpClientPoolForTests();
    const seeded = await seedSession("ov401");
    CONNECT_FAILURES.set(seeded.host, "HTTP 401 from upstream");
    try {
      const res = await probeMcpConnector({
        db: ctx.db,
        tenant_id: tenantId,
        connector: mcpConnectorView({
          tenant_id: tenantId,
          id: seeded.id,
          slug: "ov401",
          base_url: seeded.url,
        }),
        credential_override: null,
      });
      expect(res.ok).toBe(false);
      expect(res.error_code).toBe("credential_invalid");
    } finally {
      CONNECT_FAILURES.delete(seeded.host);
    }
  });

  test("an override probe of an unreadable config fails closed with the parser message", async () => {
    const res = await probeMcpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: mcpConnectorView({
        tenant_id: tenantId,
        id: "00000000-0000-4000-8000-0000000000af",
        slug: "ovbadcfg",
        base_url: null,
        config: { mcp: { transport: "carrier-pigeon" } },
      }),
      credential_override: null,
    });
    expect(res).toMatchObject({
      ok: false,
      detail: "invalid mcp connector config for ovbadcfg",
      error_code: "unknown_upstream_error",
    });
    expectSaneLatency(res.latency_ms);
  });
});

describe("probeMcpConnector operator log", () => {
  test("a failed probe logs mcp.probe.failed for the connector and a passed probe logs completion", async () => {
    __resetMcpClientPoolForTests();
    const failing = await seedSession("logfail");
    const passing = await seedSession("logpass");
    CONNECT_FAILURES.set(failing.host, "socket hang up");
    reconfigureLogger({ format: "ndjson", level: "debug" });
    const capture = captureNdjsonLogs();
    try {
      await probeMcpConnector({
        db: ctx.db,
        tenant_id: tenantId,
        connector: mcpConnectorView({
          tenant_id: tenantId,
          id: failing.id,
          slug: "logfail",
          base_url: failing.url,
        }),
      });
      await probeMcpConnector({
        db: ctx.db,
        tenant_id: tenantId,
        connector: mcpConnectorView({
          tenant_id: tenantId,
          id: "not-a-uuid",
          slug: "logthrow",
          base_url: null,
        }),
      });
      await probeMcpConnector({
        db: ctx.db,
        tenant_id: tenantId,
        connector: mcpConnectorView({
          tenant_id: tenantId,
          id: passing.id,
          slug: "logpass",
          base_url: passing.url,
        }),
      });
    } finally {
      capture.restore();
      _resetLoggerForTests();
      CONNECT_FAILURES.delete(failing.host);
    }
    const probeLogs = capture.records
      .filter((r) => typeof r.action === "string" && r.action.startsWith("mcp.probe."))
      .map((r) => ({
        module: r.module,
        action: r.action,
        connector_id: r.connector_id,
        reason: r.reason,
        ok: r.ok,
        tool_count: r.tool_count,
      }));
    expect(probeLogs).toEqual([
      {
        module: "connector",
        action: "mcp.probe.failed",
        connector_id: failing.id,
        reason: "handshake_failed",
        ok: undefined,
        tool_count: undefined,
      },
      {
        module: "connector",
        action: "mcp.probe.failed",
        connector_id: "not-a-uuid",
        reason: undefined,
        ok: undefined,
        tool_count: undefined,
      },
      {
        module: "connector",
        action: "mcp.probe.completed",
        connector_id: passing.id,
        reason: undefined,
        ok: true,
        tool_count: 2,
      },
    ]);
  });
});
