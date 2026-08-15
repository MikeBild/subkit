// HTTP integration tests for the connector authoring trio:
//   POST /v1/connectors/validate
//   POST /v1/connectors/probe
//   POST /v1/connectors/import
//
// The load-bearing claim is that none of them persist anything. An authoring
// step that quietly created a row would defeat its own purpose: the point of
// checking before saving is that nothing exists yet if the check fails. Every
// test here counts connectors before and after.
//
// The probe runs against a per-suite mock HTTP server so the credential
// override reaches a real socket rather than a stub — the failure mode being
// guarded is a probe that reports success while sending no credential at all.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { connectors } from "../../../db/schema/index.ts";
import { __setMcpPoolFactoriesForTests, type McpClientLike } from "../../../mcp/client/pool.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;
let mock: Server;
let mockBaseUrl: string;
let received: { headers: Record<string, string>; url: string }[] = [];
let mcpHeaders: Record<string, string> = {};
let mcpCloseCount = 0;

function fakeMcpClient(): McpClientLike {
  return {
    async connect() {},
    async listTools() {
      return { tools: [{ name: "draft_probe", inputSchema: { type: "object" } }] };
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
    async close() {
      mcpCloseCount += 1;
    },
  };
}

function adminAuth(): Record<string, string> {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}

async function connectorCount(): Promise<number> {
  const rows = await ctx.db
    .select({ id: connectors.id })
    .from(connectors)
    .where(eq(connectors.tenant_id, ctx.tenantId));
  return rows.length;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({
    makeClient: () => fakeMcpClient(),
    makeTransport: (_row, headers) => {
      mcpHeaders = headers;
      return {} as never;
    },
  });
  ctx = await createHttpTestServer("conn-authoring");
  mock = createServer((req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    received.push({ headers, url: req.url ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address();
  mockBaseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  mock?.close();
  await ctx?.cleanup();
}, 30_000);

describe("POST /v1/connectors/validate", () => {
  test("an invalid definition is a 200 with ok:false and the offending field", async () => {
    // Not a 4xx: the request was well-formed, the caller asked a question.
    const before = await connectorCount();
    const res = await post("/v1/connectors/validate", {
      name: "Bad S3",
      driver: "s3",
      config: { region: "eu-central-1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; issues: { path: string }[] };
    expect(body.ok).toBe(false);
    expect(body.issues.some((i) => i.path === "bucket")).toBe(true);
    expect(await connectorCount()).toBe(before);
  });

  test("a valid definition passes and still saves nothing", async () => {
    const before = await connectorCount();
    const res = await post("/v1/connectors/validate", {
      name: "Good S3",
      driver: "s3",
      config: { bucket: "b" },
    });
    const body = (await res.json()) as { ok: boolean; issues: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.issues).toEqual([]);
    expect(await connectorCount()).toBe(before);
  });

  test("a graphql definition is checked too — this driver was unvalidated before", async () => {
    const res = await post("/v1/connectors/validate", {
      name: "GQL",
      driver: "graphql",
      base_url: "https://example.com/graphql",
      config: { default_headers: { "x-api": 42 } },
    });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe("POST /v1/connectors/probe", () => {
  test("reaches the upstream with the supplied credential and saves neither", async () => {
    received = [];
    const before = await connectorCount();

    const res = await post("/v1/connectors/probe", {
      connector: {
        name: "Unsaved",
        driver: "http",
        base_url: mockBaseUrl,
        auth_type: "bearer",
        config: {},
      },
      credential: { mode: "bearer", token: "PROBE-ONLY-TOKEN" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // The credential actually went out. Without the override threading, the
    // probe would have sent an unauthenticated request and still reported ok.
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]?.headers.authorization).toBe("Bearer PROBE-ONLY-TOKEN");

    // Neither the connector nor the credential was written.
    expect(await connectorCount()).toBe(before);
  });

  test("an auth-required definition with no credential reports credential_missing", async () => {
    // Rather than probing anonymously and returning a 401 that reads like a
    // connectivity problem.
    const res = await post("/v1/connectors/probe", {
      connector: {
        name: "Unsaved No Cred",
        driver: "http",
        base_url: mockBaseUrl,
        auth_type: "bearer",
        config: {},
      },
    });
    const body = (await res.json()) as { ok: boolean; error_code?: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("credential_missing");
  });

  test("an incomplete credential is rejected as a bad request, not reported as unreachable", async () => {
    const res = await post("/v1/connectors/probe", {
      connector: { name: "X", driver: "http", base_url: mockBaseUrl, auth_type: "basic" },
      credential: { mode: "basic", username: "u" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/connectors/import", () => {
  test("a curl command becomes a draft, and nothing is saved", async () => {
    const before = await connectorCount();
    const res = await post("/v1/connectors/import", {
      source: "curl",
      content: `curl -H 'Authorization: Bearer sk_test_x' ${mockBaseUrl}/v1/customers`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft?: { driver?: string; base_url?: string } };
    expect(body.draft?.driver).toBe("http");
    expect(body.draft?.base_url).toContain("127.0.0.1");
    expect(await connectorCount()).toBe(before);
  });

  test("the returned draft is directly saveable", async () => {
    // The contract the CLI depends on: import → review → create, with no
    // reshaping in between. If the draft ever stops being a valid create body,
    // `sk connectors import --spec` breaks with a confusing 400.
    const imported = await post("/v1/connectors/import", {
      source: "curl",
      content: `curl ${mockBaseUrl}/v1/things`,
      name: "Imported Round Trip",
    });
    const { draft } = (await imported.json()) as { draft: Record<string, unknown> };

    const validated = await post("/v1/connectors/validate", draft);
    expect(((await validated.json()) as { ok: boolean }).ok).toBe(true);

    const created = await post("/v1/connectors", draft);
    expect(created.status).toBe(201);
  });
});

describe("driver-scoped auth kinds", () => {
  // `auth_type` is one shared enum, so the contract alone would offer the two
  // machine-to-machine MCP kinds to every driver. The HTTP driver throws on
  // both rather than sign a request, so a connector that declared one would be
  // stored uncallable.
  test("validate reports oauth2_client on an http definition as an issue", async () => {
    const res = await post("/v1/connectors/validate", {
      name: "Wrong Auth",
      driver: "http",
      base_url: mockBaseUrl,
      auth_type: "oauth2_client",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; issues: { path: string }[] };
    expect(body.ok).toBe(false);
    expect(body.issues.some((i) => i.path === "auth_type")).toBe(true);
  });

  test("create refuses it with a 400 rather than storing it", async () => {
    const before = await connectorCount();
    const res = await post("/v1/connectors", {
      name: "Wrong Auth Saved",
      driver: "http",
      base_url: mockBaseUrl,
      auth_type: "oauth2_private_key",
    });
    expect(res.status).toBe(400);
    expect(await connectorCount()).toBe(before);
  });

  test("patch refuses it too — the driver at rest is what has to honour it", async () => {
    const created = await post("/v1/connectors", {
      name: "Patch Target",
      driver: "http",
      base_url: mockBaseUrl,
      auth_type: "bearer",
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const patched = await fetch(`${ctx.baseUrl}/v1/connectors/${id}`, {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ auth_type: "oauth2_client" }),
    });
    expect(patched.status).toBe(400);
  });

  test("an mcp connector may declare it", async () => {
    const res = await post("/v1/connectors/validate", {
      name: "MCP M2M",
      driver: "mcp",
      base_url: "https://mcp.example.com/mcp",
      auth_type: "oauth2_client",
      config: { mcp: { transport: "http", auth: { kind: "oauth2_client_credentials" } } },
    });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("create seeds MCP transport auth from auth_type when config is omitted", async () => {
    const res = await post("/v1/connectors", {
      name: "MCP Seeded Auth",
      driver: "mcp",
      environment: "prod",
      base_url: "https://mcp-seeded.example.test/mcp",
      auth_type: "bearer",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { config?: Record<string, unknown> };
    expect(body.config).toEqual({
      mcp: { transport: "http", auth: { kind: "bearer" } },
    });
  });

  test("patch refuses an MCP auth_type/config mismatch", async () => {
    const created = await post("/v1/connectors", {
      name: "MCP Consistency Target",
      driver: "mcp",
      environment: "prod",
      base_url: "https://mcp-consistency.example.test/mcp",
      auth_type: "bearer",
    });
    const { id } = (await created.json()) as { id: string };
    const patched = await fetch(`${ctx.baseUrl}/v1/connectors/${id}`, {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ auth_type: "basic" }),
    });
    expect(patched.status).toBe(400);
  });
});

describe("POST /v1/connectors/probe — driver mcp", () => {
  test("handshakes an unsaved definition and closes the throwaway session", async () => {
    mcpCloseCount = 0;
    const before = await connectorCount();
    const res = await post("/v1/connectors/probe", {
      connector: {
        name: "Unsaved MCP",
        driver: "mcp",
        base_url: "https://mcp.example.com/mcp",
        auth_type: "none",
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(mcpCloseCount).toBe(1);
    expect(await connectorCount()).toBe(before);
  });

  test("uses the supplied bearer credential without persisting either draft", async () => {
    mcpHeaders = {};
    const before = await connectorCount();
    const res = await post("/v1/connectors/probe", {
      connector: {
        name: "Unsaved MCP With Cred",
        driver: "mcp",
        base_url: "https://mcp.example.com/mcp",
        auth_type: "bearer",
      },
      credential: { mode: "bearer", token: "PROBE-ONLY-TOKEN" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(mcpHeaders.Authorization).toBe("Bearer PROBE-ONLY-TOKEN");
    expect(await connectorCount()).toBe(before);
  });
});
