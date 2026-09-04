// Integration tests for MCP OAuth HTTP routes — mcp-oauth-discovery group.
// Shared setup + helpers live in ./mcp-oauth-test-helpers.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import type { HttpTestServer } from "../../http/tests/setup.ts";
import { setupMcpOauthServer, teardownMcpOauthServer } from "./mcp-oauth-test-helpers.ts";

let ctx: HttpTestServer;
let _db: Db;
let priorBaseUrl = "";

beforeAll(async () => {
  const s = await setupMcpOauthServer("mcp-oauth-discovery");
  ctx = s.ctx;
  _db = ctx.db;
  priorBaseUrl = s.priorBaseUrl;
}, 30_000);

afterAll(async () => {
  await teardownMcpOauthServer(ctx, priorBaseUrl);
}, 30_000);

describe("GET /.well-known/oauth-protected-resource", () => {
  test("returns 200 with RFC 9728 shaped document", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe("https://test.example.com/mcp");
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect((body.authorization_servers as string[]).length).toBeGreaterThan(0);
    expect(Array.isArray(body.scopes_supported)).toBe(true);
    expect(body.scopes_supported).toContain("mcp:read");
    expect(body.scopes_supported).not.toContain("sk:login");
  });

  test("/mcp variant also returns RFC 9728 document", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe("https://test.example.com/mcp");
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect(Array.isArray(body.scopes_supported)).toBe(true);
    expect(body.scopes_supported).toContain("mcp:read");
    expect(body.scopes_supported).not.toContain("sk:login");
  });

  test("CLI variant is audience-specific and advertises only sk:login", async () => {
    const res = await fetch(
      `${ctx.baseUrl}/.well-known/oauth-protected-resource/v1/identity/cli-session`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(body).toEqual({
      resource: "https://test.example.com/v1/identity/cli-session",
      authorization_servers: ["https://test.example.com"],
      scopes_supported: ["sk:login"],
    });
  });
});

describe("POST /mcp unauthenticated challenge", () => {
  test("returns RFC 9728 resource metadata plus least-privilege scope guidance", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oauth-discovery-test", version: "0.0.0" },
        },
      }),
    });

    expect(res.status).toBe(401);
    // Exact header: the challenge must advertise the FULL supported scope
    // set (identical to the RFC 8414 discovery document), or MCP clients
    // only ever request mcp:read and the consent screen never offers the
    // authoring/admin scopes — nor `metrics:read`, without which a
    // monitoring client cannot connect at all and goes back to a pasted key.
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://test.example.com/.well-known/oauth-protected-resource", scope="mcp:read mcp:authoring mcp:admin metrics:read"',
    );
  });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  test("returns 200 with RFC 8414 shaped document", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.issuer).toBe("string");
    expect(typeof body.authorization_endpoint).toBe("string");
    expect(typeof body.token_endpoint).toBe("string");
    expect(typeof body.registration_endpoint).toBe("string");
    expect(typeof body.revocation_endpoint).toBe("string");
    expect(Array.isArray(body.response_types_supported)).toBe(true);
    expect(Array.isArray(body.grant_types_supported)).toBe(true);
    expect(Array.isArray(body.code_challenge_methods_supported)).toBe(true);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("scopes_supported is present and non-empty", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    const body = (await res.json()) as { scopes_supported?: string[] };
    expect(Array.isArray(body.scopes_supported)).toBe(true);
    expect((body.scopes_supported ?? []).length).toBeGreaterThan(0);
    expect(body.scopes_supported).toContain("sk:login");
  });
});

// ─── POST /v1/oauth/register (DCR) ─────────────────────────────────────────

describe("AS metadata: token_endpoint_auth_methods_supported", () => {
  test("contains 'none' and does NOT contain client_secret_basic or client_secret_post", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token_endpoint_auth_methods_supported?: string[] };
    const methods = body.token_endpoint_auth_methods_supported ?? [];
    expect(methods).toContain("none");
    expect(methods).not.toContain("client_secret_basic");
    expect(methods).not.toContain("client_secret_post");
  });
});

// ── DCR redirect_uri validation ────────────────────────────────────────────────

describe("POST /v1/oauth/register", () => {
  test("registers client and returns 201 with required fields", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://myapp.example.com/callback"],
        client_name: "My Test App",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect(typeof body.client_id_issued_at).toBe("number");
    expect(Array.isArray(body.redirect_uris)).toBe(true);
    // registration_client_uri is intentionally not advertised — subkit
    // does not serve the RFC 7591 client-configuration endpoint.
    expect(body.registration_client_uri).toBeUndefined();
  });

  test("returns 400 with invalid_client_metadata for missing redirect_uris", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "NoRedirectUri" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("returns 400 for non-URL redirect_uri", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["not-a-url"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });
});

// ─── GET /v1/oauth/authorize ────────────────────────────────────────────────

describe("POST /v1/oauth/register — redirect_uri validation", () => {
  test("rejects http:// to public host with 400 invalid_client_metadata", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("rejects javascript:/data:/file: pseudo-scheme redirect URIs", async () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_client_metadata");
    }
  });

  test("allows http://localhost:3000/cb and returns 201", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:3000/cb"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(typeof body.client_id).toBe("string");
  });

  test("rejects more than 5 redirect_uris with 400 invalid_client_metadata", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [
          "https://app.example.com/cb1",
          "https://app.example.com/cb2",
          "https://app.example.com/cb3",
          "https://app.example.com/cb4",
          "https://app.example.com/cb5",
          "https://app.example.com/cb6",
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("rejects token_endpoint_auth_method=client_secret_basic with 400 invalid_client_metadata", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://myapp.example.com/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });
});

// ── DCR per-IP rate limit ──────────────────────────────────────────────────────

describe("POST /v1/oauth/register — per-IP rate limit", () => {
  test("11th registration from same IP returns 429", async () => {
    // Use a unique IP that isn't used anywhere else in this file to avoid
    // collisions with the module-level dcrBuckets map.
    const uniqueIp = "10.9.8.7";
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": uniqueIp,
        },
        body: JSON.stringify({ redirect_uris: [`https://ratelimit-test.example.com/cb${i}`] }),
      });
      lastStatus = res.status;
      // drain body
      await res.json().catch(() => null);
    }
    expect(lastStatus).toBe(429);
  });
});

// ── /token: 64KB form body limit ──────────────────────────────────────────────
