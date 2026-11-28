import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import { generateStartGrant } from "../../../connectors/oauth-start-grant.ts";
import { connectorOauthStartGrants, mcpOauthStates } from "../../../db/schema/index.ts";
import { __setSdkAuthForTests } from "../../../mcp/client/sdk-auth.ts";
import { seedMcpConnector } from "../../../mcp/client/test-fixtures.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

const AS_AUTHORIZE = "http://localhost:47811/authorize?client_id=local-client&state=s";

let server: HttpTestServer;
let publicBaseUrlBefore = "";
let handedScopes: Array<{ phase: "authorize" | "callback"; local_mcp: unknown }> = [];

const connectorUrls = {
  localhost: "http://localhost:47810/mcp",
  loopbackV4: "http://127.0.0.2:47810/mcp",
  loopbackV6: "http://[::1]:47810/mcp",
  remote: "https://remote-mcp.example.test/mcp",
} as const;
const connectorIds: Record<keyof typeof connectorUrls, string> = {
  localhost: "",
  loopbackV4: "",
  loopbackV6: "",
  remote: "",
};

beforeAll(async () => {
  server = await createHttpTestServer("mcp-oauth-local-scope");
  publicBaseUrlBefore = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });

  __setSdkAuthForTests((async (
    provider: OAuthClientProvider,
    options: { authorizationCode?: string },
  ) => {
    handedScopes.push({
      phase: options.authorizationCode ? "callback" : "authorize",
      local_mcp: (provider as unknown as { local_mcp?: unknown }).local_mcp,
    });
    if (options.authorizationCode) return "AUTHORIZED";
    await provider.saveCodeVerifier("verifier-from-fake");
    await provider.redirectToAuthorization(new URL(AS_AUTHORIZE));
    return "REDIRECT";
  }) as unknown as Parameters<typeof __setSdkAuthForTests>[0]);

  for (const [name, url] of Object.entries(connectorUrls) as Array<
    [keyof typeof connectorUrls, string]
  >) {
    connectorIds[name] = (
      await seedMcpConnector(server.db, {
        tenant_id: server.tenantId,
        slug: `local-scope-${name.toLowerCase()}`,
        transport: "http",
        url,
        auth: { kind: "oauth2" },
      })
    ).id;
  }
});

afterAll(async () => {
  __setSdkAuthForTests(null);
  await setConfigKey("server.public_base_url", publicBaseUrlBefore, { force: true });
  await server.cleanup();
});

async function openAuthorize(connector_id: string): Promise<Response> {
  const { plaintext, hash } = generateStartGrant();
  await server.db.insert(connectorOauthStartGrants).values({
    tenant_id: server.tenantId,
    connector_id,
    token_sha256: hash,
    created_by_actor_id: server.userId,
    expires_at: new Date(now() + 5 * 60_000),
  });
  return fetch(
    `${server.baseUrl}/v1/connectors/${connector_id}/mcp/authorize?grant=${encodeURIComponent(plaintext)}`,
    { redirect: "manual" },
  );
}

let callbackSequence = 0;

async function completeCallback(connector_id: string): Promise<Response> {
  callbackSequence += 1;
  const state = `local-scope-callback-${callbackSequence}`;
  await server.db.insert(mcpOauthStates).values({
    tenant_id: server.tenantId,
    connector_id,
    state,
    code_verifier: "verifier-from-fake",
    redirect_uri: `${server.baseUrl}/v1/connectors/mcp/oauth/callback`,
    started_by_actor_type: "user",
    started_by_actor_id: server.userId,
    expires_at: new Date(now() + 5 * 60_000),
  });
  return fetch(
    `${server.baseUrl}/v1/connectors/mcp/oauth/callback?state=${state}&code=local-code`,
    {
      redirect: "manual",
    },
  );
}

describe("interactive MCP OAuth carries the connector's local egress scope", () => {
  for (const name of ["localhost", "loopbackV4", "loopbackV6"] as const) {
    test(`authorize and callback for ${connectorUrls[name]} hand the provider its local origin`, async () => {
      handedScopes = [];
      const started = await openAuthorize(connectorIds[name]);
      expect(started.status).toBe(302);
      expect(started.headers.get("location")).toBe(AS_AUTHORIZE);

      await completeCallback(connectorIds[name]);

      const origin = new URL(connectorUrls[name]).href;
      expect(handedScopes).toEqual([
        { phase: "authorize", local_mcp: { origin } },
        { phase: "callback", local_mcp: { origin } },
      ]);
    });
  }

  test("a remote https connector gets no local scope on either leg", async () => {
    handedScopes = [];
    const started = await openAuthorize(connectorIds.remote);
    expect(started.status).toBe(302);
    await completeCallback(connectorIds.remote);
    expect(handedScopes).toEqual([
      { phase: "authorize", local_mcp: undefined },
      { phase: "callback", local_mcp: undefined },
    ]);
  });
});
