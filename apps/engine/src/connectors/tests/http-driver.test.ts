import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { upsertCredential } from "../../credentials/service.ts";
import {
  createEngineCtx,
  createMockServer,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
import {
  applyAuthMaterial,
  buildRequestPlan,
  executePlannedHttpRequest,
  HttpRequestInvalidError,
  parseResponseBody,
  probeHttpConnector,
} from "../drivers/http.ts";
import { resolveUrl } from "../drivers/resolve-url.ts";
import { createConnector, getConnector } from "../service.ts";
import type { ConnectorView } from "../types.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let lastRequest: {
  url: string;
  headers: Record<string, string>;
} | null = null;

beforeAll(async () => {
  ctx = await createEngineCtx("http-driver");
  mock = await createMockServer((req: IncomingMessage, res: ServerResponse) => {
    lastRequest = {
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
    };
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function makeConnector(params: {
  auth_type: "none" | "header" | "query" | "bearer" | "basic";
  config?: Record<string, unknown>;
}) {
  return await createConnector(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: `cn-${Math.random().toString(36).slice(2, 8)}`, // allow-random: legacy; review before changing
        driver: "http",
        environment: "dev",
        base_url: mock.baseUrl,
        auth_type: params.auth_type,
        config: params.config ?? {},
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
}

describe("http driver auth application", () => {
  test("bearer credential is turned into Authorization header", async () => {
    const conn = await makeConnector({ auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "bearer-xyz" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/ping",
    });
    const res = await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    await res.text();
    expect(res.status).toBe(200);
    expect(lastRequest?.headers.authorization).toBe("Bearer bearer-xyz");
    expect(lastRequest?.url).toBe("/ping");
  });

  test("step-level Authorization cannot replace the connector's bearer credential", async () => {
    const conn = await makeConnector({ auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "stale-token" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    await expect(
      buildRequestPlan({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        connector: fresh!,
        path_or_url: "/ping",
        headers: { Authorization: "eyJraWQiOiJ.id-token-from-prior-step" },
      }),
    ).rejects.toBeInstanceOf(HttpRequestInvalidError);
  });

  test("parseResponseBody parses application/x-amz-json-1.1 (AWS Cognito IDP)", () => {
    const cognito = `{"AuthenticationResult":{"IdToken":"eyJ…","AccessToken":"eyJ…","ExpiresIn":3600}}`;
    const parsed = parseResponseBody(cognito, "application/x-amz-json-1.1");
    expect(typeof parsed).toBe("object");
    expect(
      (parsed as { AuthenticationResult: { IdToken: string } }).AuthenticationResult.IdToken,
    ).toBe("eyJ…");
  });

  test("parseResponseBody parses any +json subtype (JSON:API, HAL, JSON-LD)", () => {
    const body = `{"data":{"id":"1"}}`;
    expect(parseResponseBody(body, "application/vnd.api+json")).toEqual({ data: { id: "1" } });
    expect(parseResponseBody(body, "application/hal+json")).toEqual({ data: { id: "1" } });
    expect(parseResponseBody(body, "application/ld+json; charset=utf-8")).toEqual({
      data: { id: "1" },
    });
  });

  test("header credential is applied as raw request headers", async () => {
    const conn = await makeConnector({ auth_type: "header" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "header",
        value: { mode: "header", headers: { "x-api-key": "abc123", "x-extra": "v" } },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/hdr",
    });
    await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    expect(lastRequest?.headers["x-api-key"]).toBe("abc123");
    expect(lastRequest?.headers["x-extra"]).toBe("v");
  });

  test("query credential is applied to the request URL", async () => {
    const conn = await makeConnector({ auth_type: "query" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "query",
        value: { mode: "query", query: { api_key: "k-789" } },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/q",
    });
    await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    expect(lastRequest?.url).toContain("api_key=k-789");
  });

  test("basic credential is base64-encoded into Authorization header", async () => {
    const conn = await makeConnector({ auth_type: "basic" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "basic",
        value: { mode: "basic", username: "alice", password: "s3cret" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/basic",
    });
    await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    const expected = `Basic ${Buffer.from("alice:s3cret", "utf8").toString("base64")}`;
    expect(lastRequest?.headers.authorization).toBe(expected);
  });

  test("static_headers from connector config land on the request too", async () => {
    const conn = await makeConnector({
      auth_type: "none",
      config: { static_headers: { "x-static": "static-v" } },
    });
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/s",
    });
    await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    expect(lastRequest?.headers["x-static"]).toBe("static-v");
  });

  test("plan reports applied auth_method per credential mode", async () => {
    const anon = await makeConnector({ auth_type: "none" });
    const anonFresh = await getConnector(ctx.tenantId, anon.id, ctx.testDb.db);
    const anonPlan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: anonFresh!,
      path_or_url: "/a",
    });
    expect(anonPlan.auth_method).toBe("none");

    const bearer = await makeConnector({ auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: bearer.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "t-123" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const bearerFresh = await getConnector(ctx.tenantId, bearer.id, ctx.testDb.db);
    const bearerPlan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: bearerFresh!,
      path_or_url: "/b",
    });
    expect(bearerPlan.auth_method).toBe("bearer");

    const header = await makeConnector({ auth_type: "header" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: header.id,
        environment: "dev",
        mode: "header",
        value: { mode: "header", headers: { "x-api-key": "k" } },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const headerFresh = await getConnector(ctx.tenantId, header.id, ctx.testDb.db);
    const headerPlan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: headerFresh!,
      path_or_url: "/h",
    });
    expect(headerPlan.auth_method).toBe("header");

    const basic = await makeConnector({ auth_type: "basic" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: basic.id,
        environment: "dev",
        mode: "basic",
        value: { mode: "basic", username: "u", password: "p" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const basicFresh = await getConnector(ctx.tenantId, basic.id, ctx.testDb.db);
    const basicPlan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: basicFresh!,
      path_or_url: "/ba",
    });
    expect(basicPlan.auth_method).toBe("basic");
  });
});

describe("applyAuthMaterial — oauth2 token_type handling", () => {
  function makeOauth2Connector(): ConnectorView {
    return {
      id: "00000000-0000-0000-0000-000000000099",
      tenant_id: "tenant-test",
      slug: "test-oauth2",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://api.example.test",
      config: {},
      template_slug: null,
      template_snapshot: null,
    } as unknown as ConnectorView;
  }

  test("token_type='Bearer' produces standard Bearer prefix", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "tok-1",
        token_type: "Bearer",
        refresh_token: null,
        expires_at: null,
      },
      headers,
      query,
    );
    expect(headers.Authorization).toBe("Bearer tok-1");
  });

  test("token_type=null defaults to no prefix (raw token)", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "eyJraWQiOiJ.abc",
        token_type: null,
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      query,
    );
    expect(headers.Authorization).toBe("eyJraWQiOiJ.abc");
  });

  test("token_type='' (empty string from IdP) emits raw token, not leading-space", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "raw-jwt",
        token_type: "",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      query,
    );
    expect(headers.Authorization).toBe("raw-jwt");
    expect(headers.Authorization?.startsWith(" ")).toBe(false);
  });

  test("token_type='none' (explicit opt-out) emits raw token", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "id-token-here",
        token_type: "none",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      query,
    );
    expect(headers.Authorization).toBe("id-token-here");
  });

  test("token_type='no_prefix' alias also emits raw token", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "another-jwt",
        token_type: "no_prefix",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      query,
    );
    expect(headers.Authorization).toBe("another-jwt");
  });

  test("custom scheme (e.g. 'Token' for GitLab PAT) is preserved", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "glpat-xyz",
        token_type: "Token",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      query,
    );
    expect(headers.Authorization).toBe("Token glpat-xyz");
  });

  test("token_type='bearer' (lowercase from Google) canonicalises to 'Bearer'", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "ya29.a0AQv",
        token_type: "bearer",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      query,
    );
    expect(headers.Authorization).toBe("Bearer ya29.a0AQv");
  });

  test("token_type='BEARER' (uppercase) also canonicalises to 'Bearer'", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "abc",
        token_type: "BEARER",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      query,
    );
    expect(headers.Authorization).toBe("Bearer abc");
  });
});

describe("executePlannedHttpRequest header contract", () => {
  test("rejects a non-object headers value before fetch", async () => {
    await expect(
      executePlannedHttpRequest({
        exec: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        method: "GET",
        url: new URL(`${mock.baseUrl}/ping`),
        headers: '{"Accept":"application/json"}' as unknown as Record<string, string>,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HttpRequestInvalidError);
  });

  test("rejects header names that aren't RFC 7230 tokens", async () => {
    await expect(
      executePlannedHttpRequest({
        exec: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        method: "GET",
        url: new URL(`${mock.baseUrl}/ping`),
        headers: { '{"Accept"': '"application/json"}' },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HttpRequestInvalidError);
  });

  test("rejects non-string header values", async () => {
    await expect(
      executePlannedHttpRequest({
        exec: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        method: "GET",
        url: new URL(`${mock.baseUrl}/ping`),
        headers: { "X-Number": 42 as unknown as string },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HttpRequestInvalidError);
  });
});

describe("resolveUrl — base-path preservation", () => {
  test("base with subpath + leading-slash path: appends to base path", () => {
    const url = resolveUrl("https://api.example.com/v1", "/users/me");
    expect(url.href).toBe("https://api.example.com/v1/users/me");
  });

  test("base with subpath + no-leading-slash path: appends correctly", () => {
    const url = resolveUrl("https://api.example.com/v1", "users/me");
    expect(url.href).toBe("https://api.example.com/v1/users/me");
  });

  test("base with subpath + trailing slash + leading-slash path: appends to base path", () => {
    const url = resolveUrl("https://api.example.com/v1/", "/users/me");
    expect(url.href).toBe("https://api.example.com/v1/users/me");
  });

  test("base root path + leading-slash path: resolves from origin (unchanged behaviour)", () => {
    const url = resolveUrl("https://api.example.com", "/users/me");
    expect(url.href).toBe("https://api.example.com/users/me");
  });

  test("absolute URL passthrough: base_url is ignored entirely", () => {
    const url = resolveUrl("https://api.example.com/v1", "https://other.example.com/endpoint");
    expect(url.href).toBe("https://other.example.com/endpoint");
  });

  test("deep subpath base + leading-slash path: appends, does not double-slash", () => {
    const url = resolveUrl("https://api.example.com/gmail/v1", "/users/me/messages");
    expect(url.href).toBe("https://api.example.com/gmail/v1/users/me/messages");
  });

  test("path that already includes the base prefix is NOT doubled (regression: get-last-3-gmail-messages)", () => {
    expect(
      resolveUrl("https://gmail.googleapis.com/gmail/v1", "/gmail/v1/users/me/messages").href,
    ).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    expect(
      resolveUrl("https://gmail.googleapis.com/gmail/v1", "gmail/v1/users/me/messages").href,
    ).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    expect(resolveUrl("https://api.example.com/v1", "/v1/users?limit=3").href).toBe(
      "https://api.example.com/v1/users?limit=3",
    );
  });

  test("null base_url with non-absolute path throws descriptive error", () => {
    expect(() => resolveUrl(null, "/users/me")).toThrow("no base_url");
  });
});

describe("probeHttpConnector failure diagnostics", () => {
  test("403 fallback probe carries body_snippet and allowlisted response_headers", async () => {
    const failingMock = await createMockServer((_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.setHeader("www-authenticate", 'Basic realm="restricted"');
      res.setHeader("set-cookie", "session=top-secret");
      res.end(JSON.stringify({ message: "Basic auth with password is not allowed" }));
    });
    try {
      const conn = await createConnector(
        {
          tenant_id: ctx.tenantId,
          input: {
            name: "probe-diag-403",
            driver: "http",
            environment: "dev",
            base_url: failingMock.baseUrl,
            auth_type: "none",
            config: {},
          },
          actor_id: null,
        },
        ctx.testDb.db,
      );
      const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
      const probe = await probeHttpConnector({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        connector: fresh!,
      });

      expect(probe.ok).toBe(false);
      expect(probe.status).toBe(403);
      expect(probe.error_code).toBe("scope_insufficient");
      expect(probe.body_snippet).toContain("Basic auth with password is not allowed");
      expect(probe.response_headers?.["www-authenticate"]).toBe('Basic realm="restricted"');
      expect(probe.response_headers?.["set-cookie"]).toBeUndefined();
    } finally {
      await failingMock.close();
    }
  });
});
