import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth as authorize } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  getCredentialForConnector,
  rotateOAuth2Tokens,
  upsertCredential,
} from "../../credentials/service.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { makeMcpOAuthProvider } from "./oauth-provider.ts";
import { getMcpConnector, type McpAuthConfig } from "./registry.ts";
import { resolveAuthProvider } from "./session-auth.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

let ctx: TestDb;
let tenantId: string;
const issuer = "https://trusted.example.test";
const serverUrl = "https://mcp.example.test/mcp";

beforeAll(async () => {
  ctx = await createTestDb("mcp-issuer");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "issuer", display_name: "Issuer" })
    .returning();
  if (!tenant) throw new Error("fixture tenant missing");
  tenantId = tenant.id;
});
afterAll(async () => {
  await ctx.cleanup();
});

for (const kind of ["oauth2_client_credentials", "oauth2_private_key_jwt"] as const) {
  for (const scenario of ["trusted", "changed", "missing"] as const) {
    test(`${kind}: ${scenario} issuer never silently rebinds a credential`, async () => {
      const config: McpAuthConfig = { kind, ...(scenario === "missing" ? {} : { issuer }) };
      const connector = await seedMcpConnector(ctx.db, {
        tenant_id: tenantId,
        slug: `${kind}-${scenario}`,
        url: serverUrl,
        auth: config,
      });
      await upsertCredential(
        {
          tenant_id: tenantId,
          connector_id: connector.id,
          environment: "prod",
          ...(kind === "oauth2_client_credentials"
            ? {
                mode: "oauth2_client" as const,
                value: {
                  mode: "oauth2_client" as const,
                  client_id: "fixture",
                  client_secret: "synthetic-secret",
                },
              }
            : {
                mode: "oauth2_private_key" as const,
                value: {
                  mode: "oauth2_private_key" as const,
                  client_id: "fixture",
                  private_key: "synthetic-signing-key-long-enough",
                  algorithm: "HS256",
                },
              }),
          actor_id: null,
        },
        ctx.db,
      );
      const row = await getMcpConnector(ctx.db, tenantId, connector.id);
      if (!row) throw new Error("fixture connector missing");
      const providerPromise = resolveAuthProvider(ctx.db, tenantId, row, config, "prod", "api");
      if (scenario === "missing") {
        await expect(providerPromise).rejects.toThrow("trusted OAuth issuer");
        return;
      }
      const provider = await providerPromise;
      if (!provider) throw new Error("fixture provider missing");
      const discovered = scenario === "changed" ? "https://changed.example.test" : issuer;
      let tokenRequests = 0;
      const result = authorize(provider, {
        serverUrl,
        fetchFn: async (target, init) => {
          const url = String(target);
          if (url.includes("oauth-protected-resource"))
            return Response.json({ resource: serverUrl, authorization_servers: [discovered] });
          if (url.includes(".well-known"))
            return Response.json({
              issuer: discovered,
              authorization_endpoint: `${discovered}/authorize`,
              token_endpoint: `${discovered}/token`,
              response_types_supported: ["code"],
              grant_types_supported: ["client_credentials"],
              token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt"],
            });
          if (url === `${discovered}/token`) {
            tokenRequests++;
            expect(discovered).toBe(issuer);
            if (kind === "oauth2_client_credentials")
              expect(new Headers(init?.headers).get("authorization")).toBe(
                `Basic ${Buffer.from("fixture:synthetic-secret").toString("base64")}`,
              );
            else expect(String(init?.body)).toContain("client_assertion=");
            return Response.json({ access_token: "synthetic-access", token_type: "Bearer" });
          }
          throw new Error("unexpected fixture request");
        },
      });
      if (scenario === "changed") {
        await expect(result).rejects.toThrow("bound to authorization server");
        expect(tokenRequests).toBe(0);
      } else {
        expect(await result).toBe("AUTHORIZED");
        expect(tokenRequests).toBe(1);
      }
    });
  }
}

async function interactiveFixture(slug: string) {
  const connector = await seedMcpConnector(ctx.db, {
    tenant_id: tenantId,
    slug,
    url: serverUrl,
    auth: { kind: "oauth2", issuer },
  });
  const provider = () =>
    makeMcpOAuthProvider({
      db: ctx.db,
      tenant_id: tenantId,
      connector_id: connector.id,
      environment: "prod",
      redirect_uri: "https://engine.example.test/callback",
      state: "fixture-state",
      auth: { kind: "oauth2", issuer },
      interactive: true,
      request_source: "api",
    });
  return { connector, provider };
}

test("stored OAuth credentials preserve their issuer across reload and rotation", async () => {
  const f = await interactiveFixture("issuer-roundtrip");
  await f
    .provider()
    .saveClientInformation({ client_id: "fixture", client_secret: "synthetic-secret", issuer });
  await f.provider().saveTokens({
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    issuer,
  });
  expect((await f.provider().clientInformation())?.issuer).toBe(issuer);
  expect((await f.provider().tokens())?.issuer).toBe(issuer);
  const stored = await getCredentialForConnector(tenantId, f.connector.id, "prod", ctx.db);
  if (!stored) throw new Error("fixture credential missing");
  await expect(
    rotateOAuth2Tokens(
      {
        tenant_id: tenantId,
        credential_id: stored.row.id,
        issuer: "https://changed.example.test",
        access_token: "changed",
        actor_id: null,
      },
      ctx.db,
    ),
  ).rejects.toThrow("issuer changed");
  expect((await f.provider().tokens())?.access_token).toBe("synthetic-access");
  await rotateOAuth2Tokens(
    {
      tenant_id: tenantId,
      credential_id: stored.row.id,
      issuer,
      access_token: "rotated",
      refresh_token: "rotated-refresh",
      actor_id: null,
    },
    ctx.db,
  );
  expect((await f.provider().tokens())?.issuer).toBe(issuer);
  expect((await f.provider().tokens())?.access_token).toBe("rotated");
});

test("unbound saved credentials are withheld rather than trusted from current config", async () => {
  const f = await interactiveFixture("issuer-unbound");
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: f.connector.id,
      environment: "prod",
      mode: "oauth2",
      value: { mode: "oauth2", access_token: "unbound-access", token_type: "Bearer" },
      oauth2_refresh_token: "unbound-refresh",
      actor_id: null,
    },
    ctx.db,
  );
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: f.connector.id,
      environment: "prod",
      mode: "oauth2_client",
      value: { mode: "oauth2_client", client_id: "unbound", client_secret: "unbound-secret" },
      actor_id: null,
    },
    ctx.db,
  );
  expect(await f.provider().tokens()).toBeUndefined();
  expect(await f.provider().clientInformation()).toBeUndefined();
  await expect(
    f.provider().saveTokens({ access_token: "unstamped", token_type: "Bearer" }),
  ).rejects.toThrow("issuer binding");
  await expect(f.provider().saveClientInformation({ client_id: "unstamped" })).rejects.toThrow(
    "issuer binding",
  );
  await f
    .provider()
    .saveTokens({ access_token: "new-interactive-access", token_type: "Bearer", issuer });
  expect((await f.provider().tokens())?.refresh_token).toBeUndefined();
});

test("discovery cannot move a saved interactive client secret or refresh token", async () => {
  const f = await interactiveFixture("issuer-discovery-change");
  await f
    .provider()
    .saveClientInformation({ client_id: "fixture", client_secret: "synthetic-secret", issuer });
  await f.provider().saveTokens({
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    issuer,
  });
  let secretRequests = 0;
  await expect(
    authorize(f.provider(), {
      serverUrl,
      fetchFn: async (target, init) => {
        if (init?.method === "POST" || new Headers(init?.headers).has("authorization"))
          secretRequests++;
        if (String(target).includes("oauth-protected-resource"))
          return Response.json({
            resource: serverUrl,
            authorization_servers: ["https://changed.example.test"],
          });
        return Response.json({
          issuer: "https://changed.example.test",
          authorization_endpoint: "https://changed.example.test/authorize",
          token_endpoint: "https://changed.example.test/token",
          response_types_supported: ["code"],
        });
      },
    }),
  ).rejects.toThrow();
  expect(secretRequests).toBe(0);
  expect((await f.provider().tokens())?.refresh_token).toBe("synthetic-refresh");
  await f.provider().saveTokens({
    access_token: "new-sign-in",
    token_type: "Bearer",
    issuer: "https://changed.example.test",
  });
  expect((await f.provider().tokens())?.refresh_token).toBeUndefined();
});
