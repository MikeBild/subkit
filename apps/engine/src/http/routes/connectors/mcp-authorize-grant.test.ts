import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import {
  generateStartGrant,
  mintOAuthStartGrantUrl,
  sha256Hex,
} from "../../../connectors/oauth-start-grant.ts";
import { buildReauthUrl } from "../../../connectors/reauth.ts";
import { getConnector } from "../../../connectors/service.ts";
import {
  auditLog,
  connectorOauthStartGrants,
  connectors,
  mcpOauthStates,
} from "../../../db/schema/index.ts";
import { __setSdkAuthForTests } from "../../../mcp/client/sdk-auth.ts";
import { seedMcpConnector } from "../../../mcp/client/test-fixtures.ts";
import { handleAuthenticate } from "../../../mcp/tools/authenticate.ts";
import { now } from "../../../utils/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

const AS_AUTHORIZE = "https://as.example.test/authorize?client_id=dcr-client&state=s";

let server: HttpTestServer;
let publicBaseUrlBefore = "";
let mcpId = "";
let webId = "";
let cognitoId = "";
let machineId = "";
let keyId = "";
let begun: string[] = [];

beforeAll(async () => {
  server = await createHttpTestServer("mcp-authorize-grant");
  publicBaseUrlBefore = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });

  __setSdkAuthForTests((async (provider: OAuthClientProvider) => {
    begun.push("authorize");
    await provider.saveCodeVerifier("verifier-from-fake");
    await provider.redirectToAuthorization(new URL(AS_AUTHORIZE));
    return "REDIRECT";
  }) as unknown as Parameters<typeof __setSdkAuthForTests>[0]);

  mcpId = (
    await seedMcpConnector(server.db, {
      tenant_id: server.tenantId,
      slug: "grant-mcp",
      transport: "http",
      url: "https://grant-mcp.example.test/mcp",
      auth: { kind: "oauth2" },
    })
  ).id;

  const seed = async (slug: string, auth_type: "oauth2" | "bearer", config = {}) => {
    const [row] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug,
        display_name: slug,
        driver: "http",
        environment: "prod",
        auth_type,
        base_url: `https://${slug}.example.test`,
        config,
      })
      .returning();
    if (!row) throw new Error(`seed ${slug} failed`);
    return row.id;
  };
  webId = await seed("grant-web", "oauth2", {
    oauth: { issuer_url: "https://idp.example.test", client_id: "web-client" },
  });
  cognitoId = await seed("grant-cognito", "oauth2", {
    oauth: { grant_type: "cognito_user_password" },
  });
  machineId = await seed("grant-machine", "oauth2", {
    oauth: { grant_type: "client_credentials_json", token_endpoint: "https://m.example.test/t" },
  });
  keyId = await seed("grant-key", "bearer");
});

afterEach(() => {
  begun = [];
});

afterAll(async () => {
  __setSdkAuthForTests(null);
  await setConfigKey("server.public_base_url", publicBaseUrlBefore, { force: true });
  await server.cleanup();
});

async function view(id: string) {
  const c = await getConnector(server.tenantId, id, server.db);
  if (!c) throw new Error(`connector ${id} not found`);
  return c;
}

async function mint(id: string) {
  return mintOAuthStartGrantUrl(server.db, {
    tenant_id: server.tenantId,
    connector: await view(id),
    actor_id: server.userId,
  });
}

async function seedGrant(connector_id: string, expires_at = new Date(now() + 5 * 60_000)) {
  const { plaintext, hash } = generateStartGrant();
  await server.db.insert(connectorOauthStartGrants).values({
    tenant_id: server.tenantId,
    connector_id,
    token_sha256: hash,
    created_by_actor_id: server.userId,
    expires_at,
  });
  return plaintext;
}

const open = (id: string, grant: string) =>
  fetch(`${server.baseUrl}/v1/connectors/${id}/mcp/authorize?grant=${encodeURIComponent(grant)}`, {
    redirect: "manual",
  });

async function stillHeld(grant: string): Promise<boolean> {
  const rows = await server.db
    .select()
    .from(connectorOauthStartGrants)
    .where(eq(connectorOauthStartGrants.token_sha256, sha256Hex(grant)));
  return rows.length === 1;
}

describe("the link opens the connector's own sign-in route", () => {
  test("an MCP server's link opens mcp/authorize, a web service's oauth/start", async () => {
    const mcp = await mint(mcpId);
    const web = await mint(webId);
    if (!mcp.ok || !web.ok) throw new Error("mint failed");
    const mcpUrl = new URL(mcp.url);
    const webUrl = new URL(web.url);
    expect(mcpUrl.pathname).toBe(`/v1/connectors/${mcpId}/mcp/authorize`);
    expect(mcpUrl.searchParams.get("grant")).toStartWith("skog_");
    expect(webUrl.pathname).toBe(`/v1/connectors/${webId}/oauth/start`);
    expect(mcpUrl.origin).toBe(server.baseUrl);
  });

  test("no browser sign-in, no link: a key, a Cognito password grant, a machine exchange", async () => {
    for (const id of [keyId, cognitoId, machineId]) {
      expect(await mint(id)).toEqual({ ok: false, error: "no_browser_flow" });
    }
  });

  test("the operator notification names the same route the link opens", async () => {
    expect(buildReauthUrl(await view(mcpId))).toMatchObject({
      method: "oauth2",
      reauth_url: `${server.baseUrl}/v1/connectors/${mcpId}/mcp/authorize`,
    });
    expect(buildReauthUrl(await view(webId))).toMatchObject({
      method: "oauth2",
      reauth_url: `${server.baseUrl}/v1/connectors/${webId}/oauth/start`,
    });
    expect(buildReauthUrl(await view(cognitoId))).toMatchObject({
      method: "portal_setup",
      reauth_url: `${server.baseUrl}/v1/connectors/${cognitoId}/credentials`,
    });
    expect(buildReauthUrl(await view(keyId)).method).toBe("portal_setup");
  });
});

describe("GET /v1/connectors/{id}/mcp/authorize?grant=…", () => {
  test("a browser with no key is redirected to the authorization server; the grant is spent", async () => {
    const minted = await mint(mcpId);
    if (!minted.ok) throw new Error("mint failed");
    const res = await fetch(minted.url, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(AS_AUTHORIZE);
    expect(begun).toEqual(["authorize"]);
    expect(await stillHeld(new URL(minted.url).searchParams.get("grant") ?? "")).toBe(false);

    const states = await server.db
      .select()
      .from(mcpOauthStates)
      .where(
        and(eq(mcpOauthStates.tenant_id, server.tenantId), eq(mcpOauthStates.connector_id, mcpId)),
      );
    expect(states).toHaveLength(1);
    expect(states[0]?.origin).toBe("chat");
    expect(states[0]?.started_by_actor_id).toBeNull();
    expect(states[0]?.authorization_url).toBe(AS_AUTHORIZE);
    expect(states[0]?.redirect_uri).toBe(`${server.baseUrl}/v1/connectors/mcp/oauth/callback`);

    const consumed = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "connector.oauth.grant_consumed"),
          eq(auditLog.resource_id, mcpId),
        ),
      );
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.actor_type).toBe("system");
    expect(consumed[0]?.actor_id).toBeNull();
  });

  test("a used grant is the link-expired page and begins nothing", async () => {
    const grant = await seedGrant(mcpId);
    expect((await open(mcpId, grant)).status).toBe(302);
    begun = [];
    const again = await open(mcpId, grant);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("Link expired");
    expect(begun).toEqual([]);
  });

  test("an expired grant is the link-expired page", async () => {
    const grant = await seedGrant(mcpId, new Date(now() - 1000));
    const res = await open(mcpId, grant);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Link expired");
    expect(begun).toEqual([]);
  });

  test("a grant opened on another connector's path is refused and NOT burned", async () => {
    const grant = await seedGrant(mcpId);
    const res = await open(webId, grant);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Link expired");
    expect(await stillHeld(grant)).toBe(true);
    expect((await open(mcpId, grant)).status).toBe(302);
  });

  test("a web service's grant opened on the MCP route starts nothing", async () => {
    const grant = await seedGrant(webId);
    const res = await open(webId, grant);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Sign-in could not be started");
    expect(begun).toEqual([]);
  });

  test("a grant without its value is a validation error, not a sign-in attempt", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${mcpId}/mcp/authorize`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect(begun).toEqual([]);
  });

  test("the authenticated door still requires a key", async () => {
    const res = await fetch(`${server.baseUrl}/v1/connectors/${mcpId}/mcp/authorize`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(begun).toEqual([]);
  });
});

describe("the MCP `authenticate` tool starts only the flow it runs", () => {
  const principal = () => ({
    provider: "api_key",
    kind: "user" as const,
    id: server.userId,
    tenant_id: server.tenantId,
    roles: ["admin"],
  });

  test("an MCP server is pointed at its own route; a Cognito grant has no browser sign-in", async () => {
    const mcp = await handleAuthenticate(
      { db: server.db, principal: principal() },
      { connector_id: mcpId },
    );
    expect(mcp).toMatchObject({ ok: false, data: { reason: "sign_in_route_mismatch" } });
    expect(JSON.stringify(mcp.data)).toContain(`/v1/connectors/${mcpId}/mcp/authorize`);

    const cognito = await handleAuthenticate(
      { db: server.db, principal: principal() },
      { connector_id: cognitoId },
    );
    expect(cognito).toMatchObject({ ok: false, data: { reason: "no_browser_sign_in" } });
  });
});
