import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  setupMcpOauthServer,
  teardownMcpOauthServer,
} from "../../auth/oauth/mcp-oauth-test-helpers.ts";
import { CLI_LOGIN_SCOPE } from "../../auth/oauth/resources.ts";
import { METRICS_SCOPE, withNonRemovableScopes } from "../../auth/scopes.ts";
import { getConfig, installRuntimeConfig } from "../../config/loader.ts";
import type { HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let priorBaseUrl = "";
let originalDocument: Record<string, unknown>;

beforeAll(async () => {
  const s = await setupMcpOauthServer("metrics-scope-advertised");
  ctx = s.ctx;
  priorBaseUrl = s.priorBaseUrl;
  originalDocument = clone(getConfig());
}, 30_000);

afterAll(async () => {
  installRuntimeConfig(originalDocument);
  await teardownMcpOauthServer(ctx, priorBaseUrl);
}, 30_000);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function productionShapedDocument(): Record<string, unknown> {
  const current = getConfig();
  return {
    database: { url: current.database.url },
    server: { public_base_url: current.server.public_base_url },
    auth: { session: { secret: current.auth.session.secret } },
    mcp: { api_key: "", read_only: false },
  };
}

async function advertisedScopes(): Promise<string[]> {
  const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { scopes_supported: string[] };
  return body.scopes_supported;
}

async function protectedResourceScopes(): Promise<string[]> {
  const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { scopes_supported: string[] };
  return body.scopes_supported;
}

describe("scopes_supported on a configured installation", () => {
  test("a settings document that says nothing about scopes still advertises metrics:read", async () => {
    installRuntimeConfig(productionShapedDocument());
    expect(await advertisedScopes()).toContain(METRICS_SCOPE);
    expect(await protectedResourceScopes()).toContain(METRICS_SCOPE);
  });

  test("a settings document that lists scopes explicitly cannot drop metrics:read", async () => {
    const stored = ["mcp:admin", "mcp:authoring", "mcp:read"];
    installRuntimeConfig({
      ...productionShapedDocument(),
      auth: {
        ...(productionShapedDocument().auth as object),
        mcp_oauth: { scopes_supported: stored },
      },
    });
    const advertised = await advertisedScopes();
    expect(advertised).toContain(METRICS_SCOPE);
    expect(advertised.slice(0, stored.length)).toEqual(stored);
    expect(await protectedResourceScopes()).toContain(METRICS_SCOPE);
  });

  test("an explicit list that already names every mandatory advertised scope is left exactly as written", async () => {
    const stored = [METRICS_SCOPE, CLI_LOGIN_SCOPE, "mcp:read"];
    installRuntimeConfig({
      ...productionShapedDocument(),
      auth: {
        ...(productionShapedDocument().auth as object),
        mcp_oauth: { scopes_supported: stored },
      },
    });
    expect(await advertisedScopes()).toEqual(stored);
  });

  test("the /mcp challenge advertises what discovery does", async () => {
    installRuntimeConfig({
      ...productionShapedDocument(),
      auth: {
        ...(productionShapedDocument().auth as object),
        mcp_oauth: { scopes_supported: ["mcp:read"] },
      },
    });
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain(METRICS_SCOPE);
  });
});

describe("withNonRemovableScopes", () => {
  test("appends what is missing, keeps order, and never duplicates", () => {
    expect(withNonRemovableScopes(["mcp:read"])).toEqual(["mcp:read", METRICS_SCOPE]);
    expect(withNonRemovableScopes([METRICS_SCOPE, "mcp:read"])).toEqual([
      METRICS_SCOPE,
      "mcp:read",
    ]);
    expect(withNonRemovableScopes([])).toEqual([METRICS_SCOPE]);
  });
});
