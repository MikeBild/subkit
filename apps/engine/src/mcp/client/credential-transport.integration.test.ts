import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { _withDriverFetchForTests } from "../../connectors/drivers/fetch-seam.ts";
import {
  type CredentialUseSnapshot,
  recordCredentialProviderIdentity,
} from "../../credentials/index.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { mcpOauthStates, vaultItems } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { withMcpCredentialObserver } from "./credential-observation.ts";
import { makeMcpOAuthProvider } from "./oauth-provider.ts";
import { getMcpConnector } from "./registry.ts";
import { type OpenMcpSessionResult, openMcpSession } from "./session.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

let db: TestDb;
let oauth: Awaited<ReturnType<typeof startCredentialOAuthServer>>;
let remote: MockServer;
let tenantId: string;
let connectorId: string;
let session: OpenMcpSessionResult | undefined;
let rejectOriginal = false;
let requireToken = false;
const toolTokens: string[] = [];

async function startCredentialOAuthServer() {
  let issued = 0;
  let lastGrant: string | null = null;
  let subject: string | null = null;
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signingKey = {
    ...publicKey.export({ format: "jwk" }),
    kid: "fixture-signing-key",
    use: "sig",
    alg: "RS256",
  };
  const server = await createMockServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/.well-known/openid-configuration") {
      return jsonResponse(res, 200, {
        issuer: server.baseUrl,
        authorization_endpoint: `${server.baseUrl}/authorize`,
        token_endpoint: `${server.baseUrl}/token`,
        jwks_uri: `${server.baseUrl}/jwks`,
        response_types_supported: ["code", "token"],
        grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
          "private_key_jwt",
        ],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/jwks" && req.method === "GET") {
      return jsonResponse(res, 200, { keys: [signingKey] });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      lastGrant = form.get("grant_type");
      issued += 1;
      return jsonResponse(res, 200, {
        access_token: `at-${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `rt-${issued}`,
        scope: form.get("scope") ?? "",
        ...(subject === null ? {} : { sub: subject }),
      });
    }
    return jsonResponse(res, 404, { error: "not_found" });
  });
  return {
    baseUrl: server.baseUrl,
    issuedCount: () => issued,
    lastGrantType: () => lastGrant,
    setSubject(value: string | null) {
      subject = value;
    },
    close: server.close,
  };
}

beforeAll(async () => {
  db = await createTestDb("mcp-credential-transport");
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: db.url, NODE_ENV: "test" },
    configPathOverride: join(mkdtempSync(join(tmpdir(), "subkit-mcp-credential-")), "config.json"),
  });
  await setConfigKey("server.public_base_url", "https://engine.example.test", { force: true });
  oauth = await startCredentialOAuthServer();
  oauth.setSubject("refreshed-provider-account");
  remote = await createMockServer(async (req, res) => {
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      return jsonResponse(res, 200, {
        resource: `${remote.baseUrl}/mcp`,
        authorization_servers: [oauth.baseUrl],
        bearer_methods_supported: ["header"],
      });
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    if (requireToken && !req.headers.authorization) {
      res.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${remote.baseUrl}/.well-known/oauth-protected-resource"`,
      );
      return jsonResponse(res, 401, { error: "invalid_token" });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: string | number;
      method: string;
    };
    if (message.method === "tools/call") {
      const token = req.headers.authorization ?? "";
      toolTokens.push(token);
      if (rejectOriginal && token === "Bearer original-prod-token") {
        res.setHeader(
          "www-authenticate",
          `Bearer resource_metadata="${remote.baseUrl}/.well-known/oauth-protected-resource"`,
        );
        return jsonResponse(res, 401, { error: "invalid_token" });
      }
    }
    if (message.id === undefined) {
      res.statusCode = 202;
      res.end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "credential-fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "inspect", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "ok" }] };
    jsonResponse(res, 200, { jsonrpc: "2.0", id: message.id, result });
  });
  const tenant = await seedTenant(db.db, {
    slug: "credential-transport",
    display_name: "Credential transport",
  });
  tenantId = tenant.id;
  const connector = await seedMcpConnector(db.db, {
    tenant_id: tenantId,
    slug: "credential-transport",
    url: `${remote.baseUrl}/mcp`,
    auth: { kind: "oauth2", issuer: oauth.baseUrl, client_id: "fixture-client" },
  });
  connectorId = connector.id;
  for (const environment of ["dev", "prod"] as const) {
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment,
        mode: "oauth2",
        value: {
          mode: "oauth2",
          issuer: oauth.baseUrl,
          access_token: `original-${environment}-token`,
          token_type: "Bearer",
        },
        oauth2_refresh_token: `refresh-${environment}`,
        oauth2_expires_at: new Date("2999-01-01T00:00:00.000Z"),
        verified_identity: {
          issuer: oauth.baseUrl,
          subject: `${environment}-account`,
          source: "token_endpoint",
        },
        actor_id: null,
      },
      db.db,
    );
  }
});

afterAll(async () => {
  await session?.client.close();
  await remote?.close();
  await oauth?.close();
  _resetConfigForTests();
  await db?.cleanup();
});

test("real MCP transport binds the selected token generation before and after SDK refresh", async () => {
  const row = await getMcpConnector(db.db, tenantId, connectorId);
  if (!row) throw new Error("connector fixture missing");
  const observed: CredentialUseSnapshot[] = [];
  session = await openMcpSession(db.db, tenantId, row, "prod", "api");
  expect(observed).toEqual([]);
  const client = session.client;
  await withMcpCredentialObserver(
    async (snapshot) => {
      observed.push(snapshot);
    },
    () => client.callTool({ name: "inspect", arguments: {} }),
  );
  expect(toolTokens).toEqual(["Bearer original-prod-token"]);
  expect(observed).toEqual([
    expect.objectContaining({
      connector_id: connectorId,
      environment: "prod",
      credential_generation: 1,
      identity: { issuer: oauth.baseUrl, subject: "prod-account", source: "token_endpoint" },
    }),
  ]);
  const original = structuredClone(observed[0]);
  rejectOriginal = true;
  await withMcpCredentialObserver(
    async (snapshot) => {
      observed.push(snapshot);
    },
    () => client.callTool({ name: "inspect", arguments: {} }),
  );
  expect(oauth.issuedCount()).toBe(1);
  expect(oauth.lastGrantType()).toBe("refresh_token");
  expect(toolTokens).toHaveLength(3);
  expect(toolTokens[1]).toBe("Bearer original-prod-token");
  expect(toolTokens[2]).toMatch(/^Bearer at-/);
  expect(observed[0]).toEqual(original);
  expect(observed.at(-1)).toMatchObject({
    connector_id: connectorId,
    environment: "prod",
    credential_generation: 2,
    identity: {
      issuer: oauth.baseUrl,
      subject: "refreshed-provider-account",
      source: "token_endpoint",
    },
  });
  expect(observed.some((entry) => entry.environment === "dev")).toBe(false);
  const stored = await db.db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.tenant_id, tenantId), eq(vaultItems.connector_id, connectorId)));
  expect(stored.find((entry) => entry.environment === "dev")?.credential_generation).toBe(1);
  expect(stored.find((entry) => entry.environment === "prod")?.credential_generation).toBe(2);
  expect(stored.find((entry) => entry.environment === "prod")?.verified_identity).toEqual({
    issuer: oauth.baseUrl,
    subject: "refreshed-provider-account",
    source: "token_endpoint",
  });
  expect(JSON.stringify(observed)).not.toContain("original-prod-token");
  expect(JSON.stringify(observed)).not.toContain("refresh-prod");
});

test("the initial SDK authorization code exchange retains the token endpoint subject", async () => {
  const connector = await seedMcpConnector(db.db, {
    tenant_id: tenantId,
    slug: "initial-credential-transport",
    url: `${remote.baseUrl}/mcp`,
    auth: { kind: "oauth2", issuer: oauth.baseUrl, client_id: "fixture-client" },
  });
  const redirectUri = "https://engine.example.test/v1/connectors/mcp/oauth/callback";
  await db.db.insert(mcpOauthStates).values({
    tenant_id: tenantId,
    connector_id: connector.id,
    state: "initial-identity-state",
    code_verifier: "fixture-code-verifier",
    redirect_uri: redirectUri,
    expires_at: new Date("2999-01-01T00:00:00.000Z"),
  });
  const provider = makeMcpOAuthProvider({
    db: db.db,
    tenant_id: tenantId,
    connector_id: connector.id,
    environment: "prod",
    redirect_uri: redirectUri,
    state: "initial-identity-state",
    auth: { kind: "oauth2", issuer: oauth.baseUrl, client_id: "fixture-client" },
    interactive: true,
    request_source: "api",
  });
  expect(
    await sdkAuth(provider, {
      serverUrl: `${remote.baseUrl}/mcp`,
      authorizationCode: "fixture-code",
      fetchFn: provider.fetch,
    }),
  ).toBe("AUTHORIZED");
  expect(oauth.lastGrantType()).toBe("authorization_code");
  const [stored] = await db.db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.tenant_id, tenantId),
        eq(vaultItems.connector_id, connector.id),
        eq(vaultItems.environment, "prod"),
        eq(vaultItems.mode, "oauth2"),
      ),
    );
  expect(stored?.credential_generation).toBe(1);
  expect(stored?.verified_identity).toEqual({
    issuer: oauth.baseUrl,
    subject: "refreshed-provider-account",
    source: "token_endpoint",
  });
  const tokens = await provider.tokens();
  expect(tokens).toBeDefined();
  expect(provider.credentialSnapshot(tokens?.access_token ?? "")?.identity).toEqual(
    stored?.verified_identity,
  );
});

test("M2M transports bind both client-secret and private-key tokens to their selected credential row", async () => {
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  for (const mode of ["oauth2_client", "oauth2_private_key"] as const) {
    const auth =
      mode === "oauth2_client"
        ? {
            kind: "oauth2_client_credentials" as const,
            issuer: oauth.baseUrl,
            client_id: "machine-client",
          }
        : {
            kind: "oauth2_private_key_jwt" as const,
            issuer: oauth.baseUrl,
            client_id: "machine-client",
            algorithm: "RS256",
          };
    const connector = await seedMcpConnector(db.db, {
      tenant_id: tenantId,
      slug: `machine-${mode}`,
      url: `${remote.baseUrl}/mcp`,
      auth,
    });
    const value =
      mode === "oauth2_client"
        ? { mode, client_id: "machine-client", client_secret: "machine-secret" }
        : { mode, client_id: "machine-client", private_key: privateKey, algorithm: "RS256" };
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connector.id,
        environment: "prod",
        mode,
        value,
        actor_id: null,
      },
      db.db,
    );
    const row = await getMcpConnector(db.db, tenantId, connector.id);
    if (!row) throw new Error("machine connector missing");
    let machine: OpenMcpSessionResult | undefined;
    requireToken = true;
    try {
      machine = await openMcpSession(db.db, tenantId, row, "prod", "api");
      const client = machine.client;
      const observed: CredentialUseSnapshot[] = [];
      await withMcpCredentialObserver(
        async (snapshot) => {
          observed.push(snapshot);
        },
        () => client.callTool({ name: "inspect", arguments: {} }),
      );
      const read = () =>
        db.db
          .select()
          .from(vaultItems)
          .where(
            and(
              eq(vaultItems.tenant_id, tenantId),
              eq(vaultItems.connector_id, connector.id),
              eq(vaultItems.environment, "prod"),
              eq(vaultItems.mode, mode),
            ),
          );
      const [credential] = await read();
      expect(credential?.verified_identity).toEqual({
        issuer: oauth.baseUrl,
        subject: "refreshed-provider-account",
        source: "token_endpoint",
      });
      expect(observed).toEqual([
        expect.objectContaining({
          credential_id: credential?.id,
          credential_generation: 1,
          environment: "prod",
          identity: credential?.verified_identity,
        }),
      ]);
      await upsertCredential(
        {
          tenant_id: tenantId,
          connector_id: connector.id,
          environment: "prod",
          mode,
          value,
          actor_id: null,
        },
        db.db,
      );
      await withMcpCredentialObserver(
        async (snapshot) => {
          observed.push(snapshot);
        },
        () => client.callTool({ name: "inspect", arguments: {} }),
      );
      expect(observed[1]).toEqual(observed[0]);
      expect((await read())[0]?.credential_generation).toBe(2);
      const originalSnapshot = observed[0];
      if (!originalSnapshot) throw new Error("machine credential evidence missing");
      await recordCredentialProviderIdentity(
        {
          tenant_id: tenantId,
          snapshot: originalSnapshot,
          identity: originalSnapshot.identity,
          request_source: "api",
        },
        db.db,
      );
      expect((await read())[0]?.verified_identity).toBeNull();
      expect(JSON.stringify(observed)).not.toContain("machine-secret");
      expect(JSON.stringify(observed)).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      await machine?.client.close();
      requireToken = false;
    }
  }
});

for (const replacement of ["rotate", "recreate"] as const)
  test(`SDK refresh binding survives oversized evidence and concurrent credential ${replacement}`, async () => {
    const connector = await seedMcpConnector(db.db, {
      tenant_id: tenantId,
      slug: `oversized-refresh-${replacement}`,
      url: `${remote.baseUrl}/mcp`,
      auth: { kind: "oauth2", issuer: oauth.baseUrl, client_id: "fixture-client" },
    });
    const store = (token: string) =>
      upsertCredential(
        {
          tenant_id: tenantId,
          connector_id: connector.id,
          environment: "prod",
          mode: "oauth2",
          value: {
            mode: "oauth2",
            issuer: oauth.baseUrl,
            access_token: token,
            token_type: "Bearer",
          },
          oauth2_refresh_token: "refresh-proof",
          actor_id: null,
        },
        db.db,
      );
    await store("original-before-refresh");
    const provider = makeMcpOAuthProvider({
      db: db.db,
      tenant_id: tenantId,
      connector_id: connector.id,
      environment: "prod",
      redirect_uri: "https://engine.example.test/v1/connectors/mcp/oauth/callback",
      state: "",
      auth: { kind: "oauth2", issuer: oauth.baseUrl, client_id: "fixture-client" },
      interactive: false,
      request_source: "api",
    });
    let replaced = false;
    const fetchResponse: typeof fetch = Object.assign(
      async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await fetch(target, init);
        const url = target instanceof Request ? target.url : String(target);
        if (url === `${oauth.baseUrl}/token` && (init?.method ?? "GET").toUpperCase() === "POST") {
          const body = await response.json();
          if (replacement === "recreate")
            await db.db
              .delete(vaultItems)
              .where(
                and(
                  eq(vaultItems.tenant_id, tenantId),
                  eq(vaultItems.connector_id, connector.id),
                  eq(vaultItems.environment, "prod"),
                  eq(vaultItems.mode, "oauth2"),
                ),
              );
          await store("replacement-during-refresh");
          await provider.tokens();
          replaced = true;
          return Response.json({ ...body, padding: "x".repeat(65_536) });
        }
        return response;
      },
      { preconnect() {} },
    );
    const result = await withMcpCredentialObserver(undefined, () =>
      _withDriverFetchForTests(fetchResponse, () =>
        sdkAuth(provider, { serverUrl: `${remote.baseUrl}/mcp`, fetchFn: provider.fetch }).catch(
          () => null,
        ),
      ),
    );
    expect(replaced).toBe(true);
    expect(result).not.toBe("AUTHORIZED");
    const [stored] = await db.db
      .select()
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, tenantId),
          eq(vaultItems.connector_id, connector.id),
          eq(vaultItems.environment, "prod"),
        ),
      );
    expect(stored?.credential_generation).toBe(replacement === "recreate" ? 1 : 2);
    expect((await provider.tokens())?.access_token).toBe("replacement-during-refresh");
  });

test("SDK refresh without a provider subject rotates with unknown identity", async () => {
  const connector = await seedMcpConnector(db.db, {
    tenant_id: tenantId,
    slug: "subjectless-refresh",
    url: `${remote.baseUrl}/mcp`,
    auth: { kind: "oauth2", issuer: oauth.baseUrl, client_id: "fixture-client" },
  });
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: connector.id,
      environment: "prod",
      mode: "oauth2",
      value: {
        mode: "oauth2",
        issuer: oauth.baseUrl,
        access_token: "subjectless-original",
        token_type: "Bearer",
      },
      oauth2_refresh_token: "subjectless-refresh",
      actor_id: null,
    },
    db.db,
  );
  const provider = makeMcpOAuthProvider({
    db: db.db,
    tenant_id: tenantId,
    connector_id: connector.id,
    environment: "prod",
    redirect_uri: "https://engine.example.test/v1/connectors/mcp/oauth/callback",
    state: "",
    auth: { kind: "oauth2", issuer: oauth.baseUrl, client_id: "fixture-client" },
    interactive: false,
    request_source: "api",
  });
  oauth.setSubject(null);
  try {
    const result = await withMcpCredentialObserver(undefined, () =>
      sdkAuth(provider, { serverUrl: `${remote.baseUrl}/mcp`, fetchFn: provider.fetch }),
    );
    expect(result).toBe("AUTHORIZED");
    const [stored] = await db.db
      .select()
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, tenantId),
          eq(vaultItems.connector_id, connector.id),
          eq(vaultItems.environment, "prod"),
        ),
      );
    expect(stored?.credential_generation).toBe(2);
    expect(stored?.verified_identity).toBeNull();
  } finally {
    oauth.setSubject("refreshed-provider-account");
  }
});
