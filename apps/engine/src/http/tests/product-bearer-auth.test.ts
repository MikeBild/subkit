import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { flushOidcBearerKeys } from "../../auth/providers/oidc-bearer.ts";
import { executions } from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  BEARER_NOW_SECONDS,
  startTestBearerIssuer,
  type TestBearerIssuer,
} from "../../test-helpers/oidc-bearer-issuer.ts";
import { createHttpTestServer, type HttpTestServer, loadAuthProvidersForTest } from "./setup.ts";

let ctx: HttpTestServer;
let issuer: TestBearerIssuer;
const nextUuid = createDeterministicUuidFactory(97);

function liveToken(sub: string, expiresIn = 10 * 365 * 24 * 3600) {
  return issuer.mint({ sub }, { issuedAt: BEARER_NOW_SECONDS, expiresIn });
}

async function call(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("product-bearer-auth");
  issuer = await startTestBearerIssuer();
}, 60_000);

afterAll(async () => {
  await issuer?.stop();
  if (ctx) await ctx.cleanup();
}, 60_000);

beforeEach(async () => {
  flushOidcBearerKeys();
  await loadAuthProvidersForTest(
    [
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
      issuer.provider({ tenant_slug: "t-product-bearer-auth" }),
    ],
    ctx.testDb.url,
  );
});

describe("product bearer authentication over HTTP", () => {
  test("a valid token lists only its own executions", async () => {
    const res = await call("/v1/executions", await liveToken(nextUuid()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: unknown[]; executions?: unknown[] };
    expect(body.data ?? body.executions ?? []).toEqual([]);
  });

  test("an expired token answers 401 with the bearer refusal body", async () => {
    const expired = await issuer.mint(
      { sub: nextUuid() },
      { issuedAt: BEARER_NOW_SECONDS - 7200, expiresIn: 60 },
    );
    const res = await call("/v1/executions", expired);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: "unauthorized",
      error: "unauthorized",
      message: "invalid bearer token",
    });
  });

  test("a wrong-audience token answers 401", async () => {
    const token = await issuer.mint({ sub: nextUuid() }, { audience: "other" });
    expect((await call("/v1/executions", token)).status).toBe(401);
  });

  test("SubKit API keys keep working next to the bearer provider", async () => {
    const res = await call("/v1/workflows", ctx.apiKey);
    expect(res.status).toBe(200);
  });

  test("a product principal is refused on administrative routes", async () => {
    const token = await liveToken(nextUuid());
    for (const path of ["/v1/workflows", "/v1/connectors", "/v1/users", "/v1/roles"]) {
      const res = await call(path, token);
      expect([403, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    }
    const res = await call("/v1/workflows", token);
    expect(res.status).toBe(403);
  });

  test("a product principal gets no tenant status or CLI bootstrap", async () => {
    const token = await liveToken(nextUuid());
    for (const path of ["/v1/status", "/v1/sk/bootstrap"]) {
      const res = await call(path, token);
      expect(res.status).toBe(404);
      const body = JSON.stringify(await res.json());
      expect(body).not.toContain(ctx.tenantId);
      expect(body).not.toContain("connectors_count");
    }
    expect((await call("/v1/status", ctx.apiKey)).status).toBe(200);
    expect((await call("/v1/sk/bootstrap", ctx.apiKey)).status).toBe(200);
  });

  test("a product principal is refused on the MCP endpoint before any tool runs", async () => {
    const token = await liveToken(nextUuid());
    const mcpHeaders = { accept: "application/json, text/event-stream" };
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "product-probe", version: "1" },
        },
      },
      ...["list_workflows", "find_user", "whoami", "get_engine_status", "run_workflow"].map(
        (name, index) => ({
          jsonrpc: "2.0",
          id: index + 2,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      ),
    ];
    for (const message of messages) {
      const res = await call("/mcp", token, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify(message),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("product_caller_forbidden");
    }
    const stream = await call("/mcp", token, { headers: { accept: "text/event-stream" } });
    expect(stream.status).toBe(403);
  });

  test("a product principal cannot run a workflow without or with another product", async () => {
    const token = await liveToken(nextUuid());
    for (const product of [undefined, "harmoniqs"]) {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: `foreign ${product ?? "none"}`,
        slug: `foreign-${product ?? "none"}`,
        ...(product ? { product_id: product } : {}),
        steps: [{ id: "noop", kind: "transform", language: "javascript", expression: "return 1;" }],
      });
      const res = await call("/v1/executions", token, {
        method: "POST",
        body: JSON.stringify({ source: "saved", workflow_id, hold_writes: true, input: {} }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("caller_product_mismatch");
    }
  });

  test("a product principal cannot read another caller's execution", async () => {
    const owner = await liveToken(nextUuid());
    const intruder = await liveToken(nextUuid());
    await call("/v1/executions", owner);
    const ownerList = await call("/v1/executions", owner);
    expect(ownerList.status).toBe(200);
    const [row] = await ctx.db
      .insert(executions)
      .values({
        tenant_id: ctx.tenantId,
        status: "succeeded",
        request_source: "api",
        execution_mode: "dev",
        caller_origin: "principal",
        caller_context: {
          tenantId: ctx.tenantId,
          principalId: ctx.userId,
          principalKind: "user",
          provider: "tekit-supabase",
          productId: "tekit",
        },
      })
      .returning({ id: executions.id });
    if (!row) throw new Error("execution fixture missing");
    const res = await call(`/v1/executions/${row.id}`, intruder);
    expect([403, 404]).toContain(res.status);
  });

  test("bearer providers never issue API keys through identity sessions", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: "tekit-supabase",
        identity_token: await liveToken(nextUuid()),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("bearer providers do not issue API keys");
  });

  test("the public provider listing and browser login exclude bearer providers", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/providers`);
    const body = (await res.json()) as { providers: Array<{ id: string }> };
    expect(body.providers.map((provider) => provider.id)).toEqual(["api-key"]);
    const login = await fetch(`${ctx.baseUrl}/v1/identity/login/start`, { redirect: "manual" });
    const page = await login.text();
    expect(page).not.toContain("tekit-supabase");
  });
});
