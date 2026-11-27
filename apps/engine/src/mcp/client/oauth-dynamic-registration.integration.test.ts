import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth as authorize } from "@modelcontextprotocol/sdk/client/auth.js";
import { insertMcpOAuthState, readMcpAuthorizationUrl } from "../../connectors/oauth-states.ts";
import { getOAuth2ClientCredential } from "../../credentials/service.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { now } from "../../utils/clock.ts";
import { makeMcpOAuthProvider } from "./oauth-provider.ts";
import type { McpAuthConfig } from "./registry.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

let ctx: TestDb;
let tenantId: string;
const issuer = "https://auth.example.test";
const serverUrl = "https://mcp.example.test/mcp";
const redirectUri = "https://engine.example.test/v1/connectors/mcp/oauth/callback";

beforeAll(async () => {
  ctx = await createTestDb("mcp-dcr");
  tenantId = (await seedTenant(ctx.db, { slug: "dcr", display_name: "DCR" })).id;
});
afterAll(async () => {
  await ctx.cleanup();
});

function authorizationServer() {
  const registrations: unknown[] = [];
  const fetchFn = async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(target);
    if (url.includes("oauth-protected-resource"))
      return Response.json({ resource: serverUrl, authorization_servers: [issuer] });
    if (url.includes(".well-known"))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
    if (url === `${issuer}/register`) {
      registrations.push(JSON.parse(String(init?.body)));
      return Response.json(
        {
          client_id: "dcr-client-1",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        },
        { status: 201 },
      );
    }
    throw new Error(`unexpected fixture request ${url}`);
  };
  return { registrations, fetchFn };
}

async function startSignIn(connector_id: string, auth: McpAuthConfig, state: string) {
  await insertMcpOAuthState(ctx.db, {
    tenant_id: tenantId,
    connector_id,
    state,
    code_verifier: "",
    redirect_uri: redirectUri,
    expires_at: new Date(now() + 600_000),
  });
  const provider = makeMcpOAuthProvider({
    db: ctx.db,
    tenant_id: tenantId,
    connector_id,
    environment: "prod",
    redirect_uri: redirectUri,
    state,
    auth,
    interactive: true,
    request_source: "api",
  });
  return provider;
}

test("a repeated sign-in reuses the dynamically registered client", async () => {
  const auth: McpAuthConfig = { kind: "oauth2" };
  const connector = await seedMcpConnector(ctx.db, {
    tenant_id: tenantId,
    slug: "dcr-reuse",
    url: serverUrl,
    auth,
  });
  const server = authorizationServer();

  const first = await startSignIn(connector.id, auth, "dcr-state-first");
  expect(await authorize(first, { serverUrl, fetchFn: server.fetchFn })).toBe("REDIRECT");
  expect(first.registeredClient).toBe(true);
  expect(server.registrations).toHaveLength(1);

  const second = await startSignIn(connector.id, auth, "dcr-state-second");
  expect(await authorize(second, { serverUrl, fetchFn: server.fetchFn })).toBe("REDIRECT");
  expect(second.registeredClient).toBe(false);
  expect(server.registrations).toHaveLength(1);

  const stored = await getOAuth2ClientCredential(tenantId, connector.id, "prod", ctx.db);
  expect(stored?.client_id).toBe("dcr-client-1");
  const url = new URL((await readMcpAuthorizationUrl(ctx.db, tenantId, "dcr-state-second")) ?? "");
  expect(url.searchParams.get("client_id")).toBe("dcr-client-1");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});

test("a configured public client signs in with PKCE and never registers", async () => {
  const auth: McpAuthConfig = {
    kind: "oauth2",
    issuer,
    client_id: "public-client-1",
    token_endpoint_auth_method: "none",
  };
  const connector = await seedMcpConnector(ctx.db, {
    tenant_id: tenantId,
    slug: "public-client",
    url: serverUrl,
    auth,
  });
  const server = authorizationServer();

  const provider = await startSignIn(connector.id, auth, "public-state");
  expect(await authorize(provider, { serverUrl, fetchFn: server.fetchFn })).toBe("REDIRECT");

  expect(server.registrations).toHaveLength(0);
  expect(provider.registeredClient).toBe(false);
  expect(await provider.clientInformation()).toMatchObject({
    client_id: "public-client-1",
    token_endpoint_auth_method: "none",
  });
  const url = new URL((await readMcpAuthorizationUrl(ctx.db, tenantId, "public-state")) ?? "");
  expect(url.searchParams.get("client_id")).toBe("public-client-1");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});
