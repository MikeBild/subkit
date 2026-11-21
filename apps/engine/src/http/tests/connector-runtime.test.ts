import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  recordConnectorProbed,
  recordMcpExternalToolInvoked,
} from "../../audit/recorders/index.ts";
import { createConnector } from "../../connectors/index.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { apiKeys, auditLog, connectorMcpSessions } from "../../db/schema/index.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createMockServer, jsonResponse } from "../../test-helpers/mock-http.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x5c);

let srv: HttpTestServer;
let mcpId = "";
let httpId = "";
let readOnlyKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function window(): string {
  const to = new Date(getTestNow() + 60_000);
  const from = new Date(to.getTime() - 3_600_000);
  return `bucket=hour&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

function call(path: string, init: RequestInit = {}, key = srv.apiKey): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function mcpCall(outcome: "success" | "error" | "cancelled"): Promise<void> {
  await recordMcpExternalToolInvoked({
    tenant_id: srv.tenantId,
    actor_id: srv.userId,
    connector_id: mcpId,
    connector_slug: "runtime-mcp",
    remote_tool: "search_items",
    operation: "tools/call",
    outcome,
    duration_ms: 40,
    byte_count: 10,
    request_source: "chat",
    executor: srv.db,
  });
}

beforeAll(async () => {
  srv = await createHttpTestServer("connector-runtime");
  const mcp = await seedMcpConnector(srv.db, {
    tenant_id: srv.tenantId,
    slug: "runtime-mcp",
    transport: "http",
    url: "https://runtime-mcp.example.com/mcp",
  });
  mcpId = mcp.id;
  const http = await createConnector(
    {
      tenant_id: srv.tenantId,
      actor_id: null,
      input: {
        name: "Runtime HTTP",
        slug: "runtime-http",
        driver: "http",
        environment: "prod",
        auth_type: "header",
        base_url: "https://runtime-http.example.com",
        config: {},
      },
    },
    srv.db,
  );
  httpId = http.id;

  await mcpCall("success");
  await mcpCall("success");
  await mcpCall("error");
  await mcpCall("cancelled");
  await srv.db.insert(auditLog).values({
    id: uuid(),
    tenant_id: srv.tenantId,
    actor_type: "system",
    action: "connector.invoked",
    resource_type: "connector",
    resource_id: mcpId,
    result: "success",
    metadata: { connector_id: mcpId, connector_slug: "runtime-mcp", driver: "mcp" },
  });
  await srv.db.insert(auditLog).values({
    id: uuid(),
    tenant_id: srv.tenantId,
    actor_type: "system",
    action: "connector.invoked",
    resource_type: "connector",
    resource_id: httpId,
    result: "error",
    reason: "upstream answered 401",
    metadata: {
      connector_id: httpId,
      connector_slug: "runtime-http",
      driver: "http",
      status_code: 401,
      latency_ms: 12,
    },
  });
  await srv.db.insert(connectorMcpSessions).values({
    connector_id: mcpId,
    tenant_id: srv.tenantId,
    negotiated_protocol_version: "2025-06-18",
    server_capabilities: { tools: {}, resources: {} },
    last_handshake_at: new Date(getTestNow()),
    consecutive_failures: 0,
  });

  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
  const plaintext = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: srv.userId,
    prefix: plaintext.slice(0, 12),
    token_sha256: sha256Hex(plaintext),
    scopes: ["connector:read"],
  });
  readOnlyKey = plaintext;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
});

interface StatsBody {
  totals: {
    calls: { total: number; by_outcome: { success: number; denied: number; error: number } };
  };
  groups: Array<{ key: Record<string, string>; totals: { calls: { total: number } } }>;
}

describe("GET /v1/stats/connectors — mcp calls", () => {
  test("a per-connector read counts every mcp call once; a stopped call is not a failure", async () => {
    const res = await call(`/v1/stats/connectors?${window()}&connector_id=${mcpId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsBody;
    expect(body.totals.calls.total).toBe(4);
    expect(body.totals.calls.by_outcome).toEqual({ success: 2, denied: 1, error: 1 });
  });

  test("the driver filter and the grouped read agree with the per-connector read", async () => {
    const byDriver = (await (
      await call(`/v1/stats/connectors?${window()}&driver=mcp`)
    ).json()) as StatsBody;
    expect(byDriver.totals.calls.total).toBe(4);
    const grouped = (await (
      await call(`/v1/stats/connectors?${window()}&group_by=connector_id`)
    ).json()) as StatsBody;
    const mcpGroup = grouped.groups.find((g) => g.key.connector_id === mcpId);
    expect(mcpGroup?.totals.calls.total).toBe(4);
  });
});

describe("GET /v1/connectors/{id}/runtime", () => {
  test("mcp: newest success, the failure as a class, the negotiated session", async () => {
    const res = await call(`/v1/connectors/${mcpId}/runtime`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.last_success_at).toBe("string");
    expect(body.last_failure).toMatchObject({ code: "remote_error", cause_class: "driver_error" });
    expect(body.recorded).toBe(true);
    expect(body.mcp_session).toMatchObject({
      protocol_version: "2025-06-18",
      capabilities: ["resources", "tools"],
      consecutive_failures: 0,
    });
  });

  test("http: a 401 reads as a sign-in failure, and no raw reason leaves the engine", async () => {
    const res = await call(`/v1/connectors/${httpId}/runtime`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.last_success_at).toBeNull();
    expect(body.last_failure).toMatchObject({ code: "4xx_auth", cause_class: "auth_failed" });
    expect(body.mcp_session).toBeNull();
    expect(JSON.stringify(body)).not.toContain("upstream answered");
  });
});

describe("GET /v1/connectors/{id}/runtime — a new credential resolves an older rejected sign-in", () => {
  const minute = 60_000;
  let seq = 0;

  async function connector(): Promise<string> {
    const slug = `runtime-renewed-${++seq}`;
    const created = await createConnector(
      {
        tenant_id: srv.tenantId,
        actor_id: null,
        input: {
          name: slug,
          slug,
          driver: "http",
          environment: "prod",
          auth_type: "header",
          base_url: "https://runtime-renewed.example.com",
          config: {},
        },
      },
      srv.db,
    );
    return created.id;
  }

  async function failedCall(id: string, at: number, status: number): Promise<void> {
    await srv.db.insert(auditLog).values({
      id: uuid(),
      ts: new Date(at),
      tenant_id: srv.tenantId,
      actor_type: "system",
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: id,
      result: "error",
      metadata: { connector_id: id, driver: "http", status_code: status },
    });
  }

  async function credentialStored(
    id: string,
    at: number,
    action: "vault.item.created" | "vault.item.updated" | "vault.item.rotated",
  ): Promise<void> {
    await srv.db.insert(auditLog).values({
      id: uuid(),
      ts: new Date(at),
      tenant_id: srv.tenantId,
      actor_type: "system",
      action,
      resource_type: "vault_item",
      resource_id: uuid(),
      result: "success",
      metadata: { connector_id: id, environment: "prod", mode: "oauth2", source: "oauth_callback" },
    });
  }

  async function runtime(id: string): Promise<Record<string, unknown>> {
    const res = await call(`/v1/connectors/${id}/runtime`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  test("a rejected sign-in before the newest sign-in is not the last failure", async () => {
    const id = await connector();
    await failedCall(id, getTestNow() - 60 * minute, 401);
    await credentialStored(id, getTestNow() - 10 * minute, "vault.item.updated");
    const body = await runtime(id);
    expect(body.last_failure).toBeNull();
    expect(body.last_success_at).toBeNull();
  });

  test("a rejected sign-in after the newest sign-in is still the last failure", async () => {
    const id = await connector();
    await credentialStored(id, getTestNow() - 60 * minute, "vault.item.created");
    await failedCall(id, getTestNow() - 10 * minute, 403);
    expect((await runtime(id)).last_failure).toMatchObject({ cause_class: "auth_failed" });
  });

  test("a failure that is not about the credential stays after a sign-in", async () => {
    const id = await connector();
    await failedCall(id, getTestNow() - 60 * minute, 503);
    await credentialStored(id, getTestNow() - 10 * minute, "vault.item.updated");
    expect((await runtime(id)).last_failure).toMatchObject({ code: "5xx" });
  });

  test("a background token refresh resolves no rejected sign-in", async () => {
    const id = await connector();
    await failedCall(id, getTestNow() - 60 * minute, 401);
    await credentialStored(id, getTestNow() - 10 * minute, "vault.item.rotated");
    expect((await runtime(id)).last_failure).toMatchObject({ cause_class: "auth_failed" });
  });

  test("another connector's sign-in resolves nothing here", async () => {
    const id = await connector();
    const other = await connector();
    await failedCall(id, getTestNow() - 60 * minute, 401);
    await credentialStored(other, getTestNow() - 10 * minute, "vault.item.updated");
    expect((await runtime(id)).last_failure).toMatchObject({ cause_class: "auth_failed" });
  });
});

describe("POST /v1/connectors/{id}/test is the newest call on record", () => {
  async function probeRows(connectorId: string) {
    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "connector.invoked"),
          eq(auditLog.resource_id, connectorId),
        ),
      );
    return rows.filter((row) => (row.metadata as { method?: string }).method === "PROBE");
  }

  async function seed(slug: string): Promise<string> {
    const connector = await createConnector(
      {
        tenant_id: srv.tenantId,
        actor_id: null,
        input: {
          name: slug,
          slug,
          driver: "http",
          environment: "prod",
          auth_type: "none",
          base_url: "http://127.0.0.1:9",
          config: {},
        },
      },
      srv.db,
    );
    return connector.id;
  }

  test("a test from the API is recorded, attributed, and read back by the runtime", async () => {
    const id = await seed("runtime-probed");
    const res = await call(`/v1/connectors/${id}/test`, { method: "POST" });
    expect(res.status).toBe(200);
    const probe = (await res.json()) as { ok: boolean };
    expect(probe.ok).toBe(false);

    const rows = await probeRows(id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.result).toBe("error");
    expect(rows[0]?.actor_id).toBe(srv.userId);

    const runtime = (await (await call(`/v1/connectors/${id}/runtime`)).json()) as {
      last_success_at: string | null;
      last_failure: { at: string } | null;
    };
    expect(runtime.last_success_at).toBeNull();
    expect(typeof runtime.last_failure?.at).toBe("string");
  });

  test("a root that answers 401 without a probe_endpoint comes back unverified with its warning", async () => {
    const upstream = await createMockServer((_req, res) => {
      jsonResponse(res, 401, { error: "unauthorized" });
    });
    try {
      const connector = await createConnector(
        {
          tenant_id: srv.tenantId,
          actor_id: null,
          input: {
            name: "runtime-probed-root-401",
            slug: "runtime-probed-root-401",
            driver: "http",
            environment: "prod",
            auth_type: "bearer",
            base_url: upstream.baseUrl,
            config: {},
          },
        },
        srv.db,
      );
      await upsertCredential(
        {
          tenant_id: srv.tenantId,
          connector_id: connector.id,
          environment: "prod",
          mode: "bearer",
          value: { mode: "bearer", token: "valid-token" },
          actor_id: null,
        },
        srv.db,
      );
      const res = await call(`/v1/connectors/${connector.id}/test`, { method: "POST" });
      expect(res.status).toBe(200);
      const probe = (await res.json()) as {
        ok: boolean;
        error_code?: string;
        warning_only?: boolean;
        warnings?: Array<{ code: string; message: string }>;
      };
      expect(probe.ok).toBe(false);
      expect(probe.error_code).toBe("credential_unverified");
      expect(probe.warning_only).toBe(true);
      expect(probe.warnings?.map((w) => w.code)).toEqual(["PROBE_AUTH_UNVERIFIED"]);
    } finally {
      await upstream.close();
    }
  });

  test("a passed test moves the last successful call", async () => {
    const id = await seed("runtime-probed-ok");
    await recordConnectorProbed({
      tenant_id: srv.tenantId,
      actor_id: srv.userId,
      executor: srv.db,
      connector: {
        id,
        slug: "runtime-probed-ok",
        driver: "http",
        environment: "prod",
        base_url: "https://api.example.org",
      },
      result: { ok: true, status: 200, latency_ms: 12 },
    });
    const runtime = (await (await call(`/v1/connectors/${id}/runtime`)).json()) as {
      last_success_at: string | null;
      last_failure: unknown;
    };
    expect(typeof runtime.last_success_at).toBe("string");
    expect(runtime.last_failure).toBeNull();
  });

  test("a disabled connector's refused test sent nothing and is not a call", async () => {
    const id = await seed("runtime-probed-off");
    expect((await call(`/v1/connectors/${id}/disable`, { method: "POST" })).status).toBe(200);
    const res = await call(`/v1/connectors/${id}/test`, { method: "POST" });
    const probe = (await res.json()) as { ok: boolean; error_code?: string };
    expect(probe.error_code).toBe("connector_disabled");
    expect(await probeRows(id)).toEqual([]);
    const runtime = (await (await call(`/v1/connectors/${id}/runtime`)).json()) as {
      last_failure: unknown;
    };
    expect(runtime.last_failure).toBeNull();
  });
});

describe("PUT /v1/connectors/{id}/mcp/tool-confirmation", () => {
  test("a principal without connector:write is refused", async () => {
    const res = await call(
      `/v1/connectors/${mcpId}/mcp/tool-confirmation`,
      { method: "PUT", body: JSON.stringify({ tool: "search_items", confirm: false }) },
      readOnlyKey,
    );
    expect(res.status).toBe(403);
    expect((await call(`/v1/connectors/${mcpId}/runtime`, {}, readOnlyKey)).status).toBe(200);
  });

  test("an operator's decision is stored and audited with actor, tool, old and new", async () => {
    const res = await call(`/v1/connectors/${mcpId}/mcp/tool-confirmation`, {
      method: "PUT",
      body: JSON.stringify({ tool: "search_items", confirm: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tool: "search_items",
      confirm: false,
      tools_without_confirmation: ["search_items"],
    });
    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "connector.updated"),
          eq(auditLog.resource_id, mcpId),
          eq(auditLog.reason, "mcp_tool_confirmation"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe(srv.userId);
    expect(rows[0]?.metadata).toMatchObject({
      tool: "search_items",
      old_confirm: true,
      new_confirm: false,
    });
  });

  test("a connector edit keeps the list and may not name a different one", async () => {
    const kept = await call(`/v1/connectors/${mcpId}`, {
      method: "PATCH",
      body: JSON.stringify({ config: { mcp: { transport: "http", auth: { kind: "none" } } } }),
    });
    expect(kept.status).toBe(200);
    const view = (await kept.json()) as { config: { mcp: Record<string, unknown> } };
    expect(view.config.mcp.tools_without_confirmation).toEqual(["search_items"]);

    const widened = await call(`/v1/connectors/${mcpId}`, {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          mcp: {
            transport: "http",
            auth: { kind: "none" },
            tools_without_confirmation: ["search_items", "x"],
          },
        },
      }),
    });
    expect(widened.status).toBe(400);
  });

  test("a connector with no remote tools answers 422", async () => {
    const res = await call(`/v1/connectors/${httpId}/mcp/tool-confirmation`, {
      method: "PUT",
      body: JSON.stringify({ tool: "anything", confirm: false }),
    });
    expect(res.status).toBe(422);
  });
});

describe("GET /v1/connectors/{id}/credential — header names", () => {
  test("names the header a key is sent in, never the key", async () => {
    const attach = await call(`/v1/connectors/${httpId}/credentials`, {
      method: "POST",
      body: JSON.stringify({ mode: "header", headers: { "X-API-KEY": "very-secret-value" } }),
    });
    expect(attach.status).toBe(201);
    const res = await call(`/v1/connectors/${httpId}/credential`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe("header");
    expect(body.header_names).toEqual(["X-API-KEY"]);
    expect(JSON.stringify(body)).not.toContain("very-secret-value");
  });
});
