// A connector states how a person signs it in, and both sign-in routes say
// why one cannot start.
//
// What the tests pin:
//   1. `sign_in` on the connector representation: a web service with an
//      account starts at `/oauth/start`, an MCP server with an account at
//      `/mcp/authorize`, and a key or a machine-to-machine OAuth has none.
//   2. A web service made by hand with its OAuth client details is signed in
//      through the route its representation names, and its client secret
//      never comes back.
//   3. A sign-in service whose discovery fails is a named 502, not a 500.
//   4. The Cockpit is told the redirect address an OAuth app must allow.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../../auth/browser-session.ts";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../../credentials/oauth2/tests/mock-server.ts";
import { sessions } from "../../../db/schema/index.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let mock: MockOAuthServer;
let publicBaseUrlBefore = "";

beforeAll(async () => {
  server = await createHttpTestServer("connector-sign-in");
  publicBaseUrlBefore = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  mock = await startMockOAuthServer();
});

afterAll(async () => {
  await setConfigKey("server.public_base_url", publicBaseUrlBefore, { force: true });
  await mock.close();
  await server.cleanup();
});

const auth = () => ({
  authorization: `Bearer ${server.apiKey}`,
  "content-type": "application/json",
});

async function create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.baseUrl}/v1/connectors`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ environment: "prod", ...body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

describe("the connector states its sign-in", () => {
  test("a web service with an account starts at oauth/start", async () => {
    const c = await create({
      name: "Web account",
      slug: "web-account",
      driver: "http",
      base_url: "https://api.example.com",
      auth_type: "oauth2",
    });
    expect(c.sign_in).toEqual({ kind: "oauth", start: `/v1/connectors/${c.id}/oauth/start` });
  });

  test("an MCP server with an account starts at mcp/authorize", async () => {
    const c = await create({
      name: "MCP account",
      slug: "mcp-account",
      driver: "mcp",
      base_url: "https://mcp.example.com/mcp",
      auth_type: "oauth2",
    });
    expect(c.sign_in).toEqual({ kind: "mcp", start: `/v1/connectors/${c.id}/mcp/authorize` });
    // The list and the single read say the same.
    const one = (await (
      await fetch(`${server.baseUrl}/v1/connectors/${c.id}`, { headers: auth() })
    ).json()) as Record<string, unknown>;
    expect(one.sign_in).toEqual(c.sign_in);
  });

  test("a key, no sign-in and machine-to-machine OAuth have no browser sign-in", async () => {
    const key = await create({
      name: "Web key",
      slug: "web-key",
      driver: "http",
      base_url: "https://api.example.com",
      auth_type: "bearer",
    });
    const none = await create({
      name: "MCP open",
      slug: "mcp-open",
      driver: "mcp",
      base_url: "https://open.example.com/mcp",
      auth_type: "none",
    });
    const machine = await create({
      name: "MCP machine",
      slug: "mcp-machine",
      driver: "mcp",
      base_url: "https://machine.example.com/mcp",
      auth_type: "oauth2_client",
    });
    expect(key.sign_in).toBeNull();
    expect(none.sign_in).toBeNull();
    expect(machine.sign_in).toBeNull();
  });
});

describe("a web service made by hand signs in with its own OAuth client", () => {
  test("the stated route answers with the provider's authorization address; the secret stays", async () => {
    const c = await create({
      name: "Hand OAuth",
      slug: "hand-oauth",
      driver: "http",
      base_url: "https://api.example.com",
      auth_type: "oauth2",
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          client_id: "hand-client",
          client_secret: "hand-secret-value",
          scope: "read write",
        },
      },
    });
    expect(JSON.stringify(c)).not.toContain("hand-secret-value");
    const oauth = (c.config as { oauth: Record<string, unknown> }).oauth;
    expect(oauth.client_id).toBe("hand-client");
    expect(oauth.client_secret).not.toBe("hand-secret-value");

    const start = (c.sign_in as { start: string }).start;
    const res = await fetch(`${server.baseUrl}${start}`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_url: string };
    const url = new URL(body.authorization_url);
    expect(`${url.origin}${url.pathname}`).toBe(`${mock.baseUrl}/authorize`);
    expect(url.searchParams.get("client_id")).toBe("hand-client");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("redirect_uri")).toBe(`${server.baseUrl}/v1/oauth/callback`);
  });

  test("a sign-in service without a discovery document is a named 502", async () => {
    const c = await create({
      name: "No discovery",
      slug: "no-discovery",
      driver: "http",
      base_url: "https://api.example.com",
      auth_type: "oauth2",
      config: { oauth: { issuer_url: `${mock.baseUrl}/nowhere`, client_id: "c" } },
    });
    const res = await fetch(`${server.baseUrl}/v1/connectors/${c.id}/oauth/start`, {
      method: "POST",
      headers: auth(),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("oauth_start_failed");
    expect(body.message).not.toContain(mock.baseUrl);
  });
});

describe("the Cockpit is told the redirect address", () => {
  test("bootstrap carries the engine's OAuth callback", async () => {
    const [session] = await server.db
      .insert(sessions)
      .values({
        tenant_id: server.tenantId,
        user_id: server.userId,
        expires_at: new Date(now() + 60 * 60_000),
        absolute_expires_at: new Date(now() + 60 * 60_000),
        last_seen_at: new Date(now()),
      })
      .returning();
    if (!session) throw new Error("browser session seed failed");
    const payload = { tenant_id: server.tenantId, user_id: server.userId, session_id: session.id };
    const cookie = browserSessionCookie(await signBrowserSession(payload));
    const res = await fetch(`${server.baseUrl}/v1/cockpit/bootstrap`, {
      headers: {
        cookie,
        "x-subkit-csrf": await signBrowserCsrf(payload),
        "x-subkit-client": "cockpit",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { oauth_callback_url: string | null };
    expect(body.oauth_callback_url).toBe(`${server.baseUrl}/v1/oauth/callback`);
  });
});
