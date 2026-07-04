// Integration tests for POST /v1/connectors/{id}/oauth/start when
// the connector template has oauth.dynamic_registration=true.
//
// Covers:
//   - Registration is called BEFORE the authorization redirect (order test).
//   - Credential is persisted and client_id written back to connector config.
//   - Registration failure → structured error and audit_log row.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../../config/loader.ts";
import { __resetOAuth2CacheForTests } from "../../../credentials/oauth2/client.ts";
import { auditLog, connectors, credentials } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

// ---------------------------------------------------------------------------
// Mock IdP
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer | string) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string)),
    );
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface MockIdPHandle {
  baseUrl: string;
  close: () => Promise<void>;
  requestLog: () => string[];
  setRegisterStatus: (status: number) => void;
  setClientId: (id: string) => void;
}

async function startMockIdP(): Promise<MockIdPHandle> {
  const log: string[] = [];
  let registerStatus = 201;
  let clientId = "dyn-route-client-id";

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    log.push(`${req.method} ${url.pathname}`);

    if (
      url.pathname === "/.well-known/openid-configuration" ||
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      return;
    }

    if (url.pathname === "/register" && req.method === "POST") {
      await readBody(req);
      if (registerStatus >= 200 && registerStatus < 300) {
        res.statusCode = registerStatus;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            client_id: clientId,
            client_secret: "dyn-route-secret",
            client_id_issued_at: Math.floor(Date.now() / 1000), // allow-wall-clock: mock IdP issued_at field
          }),
        );
      } else {
        res.statusCode = registerStatus;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ error: "unauthorized_client", error_description: "test failure" }),
        );
      }
      return;
    }

    if (url.pathname === "/authorize" && req.method === "GET") {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const u = new URL(redirect);
      u.searchParams.set("code", `code-${Date.now()}`); // allow-wall-clock: mock IdP authorization code
      u.searchParams.set("state", state);
      res.statusCode = 302;
      res.setHeader("location", u.toString());
      res.end();
      return;
    }

    if (url.pathname === "/token" && req.method === "POST") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: `at-${Date.now()}`, // allow-wall-clock: mock IdP token response
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `rt-${Date.now()}`, // allow-wall-clock: mock IdP token response
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requestLog: () => [...log],
    setRegisterStatus: (s: number) => {
      registerStatus = s;
    },
    setClientId: (id: string) => {
      clientId = id;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Minimal valid ConnectorTemplate snapshot with dynamic_registration=true.
// This mirrors the shape ConnectorTemplateSchema accepts. The snapshot is
// stored in the connector row and read by getConnectorTemplateSnapshot().
// ---------------------------------------------------------------------------

function makeDynRegSnapshot(baseUrl: string): Record<string, unknown> {
  return {
    version: 1,
    slug: "test-dynreg",
    name: "Test Dynamic Reg",
    driver: "http",
    base_url: "https://example.test",
    auth_type: "oauth2",
    oauth: {
      issuer_url: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      scopes: "openid",
      grant_type: "authorization_code",
      token_auth_method: "body",
      token_content_type: "form",
      use_pkce: true,
      client_id: null,
      extra_headers: {},
      dynamic_registration: true,
    },
    ingestion_source: "unsupported",
    ingestion_url: null,
    // icon must be a non-null string per ConnectorTemplateSchema.
    icon: "test.svg",
    description: "Integration test template",
    category: "productivity",
    tags: [],
    aliases: [],
    setup_instructions: "Integration test — no setup needed.",
    auth_options: [],
    url_pattern: null,
    keywords: [],
    inline_schema: null,
    probe_endpoint: null,
    credential_hints: [],
    base_url_options: [],
    pagination_defaults: null,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
    recipes: [],
    verified_at: null,
    operator_quirks: {},
    default_skill: null,
    example_paths: [],
    aws_service: null,
    aws_region: null,
    respects_robots: false,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let server: HttpTestServer;
let idp: MockIdPHandle;

beforeAll(async () => {
  server = await createHttpTestServer("oauth-dynreg");
  idp = await startMockIdP();
  __resetOAuth2CacheForTests();
  // Set the engine's public_base_url so buildOAuthRedirectUri can
  // synthesize the redirect_uri for the oauth/start handler. Without
  // this config key the route throws BadRequestError(400) before
  // even attempting dynamic registration.
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
});

afterAll(async () => {
  await idp.close();
  __resetOAuth2CacheForTests();
  await server.cleanup();
});

// Reset the oauth cache between tests so discovery is re-done fresh.
// This prevents stale cache entries from bleeding across tests.
afterEach(() => {
  __resetOAuth2CacheForTests();
});

describe("POST /v1/connectors/{id}/oauth/start — dynamic_registration=true", () => {
  test("registration is called BEFORE the authorization redirect is issued", async () => {
    idp.setRegisterStatus(201);
    idp.setClientId("dyn-order-test-client");

    const [row] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug: "dynreg-order-connector",
        display_name: "DynReg Order Test",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://example.test",
        config: {
          oauth: {
            issuer_url: idp.baseUrl,
            authorization_endpoint: `${idp.baseUrl}/authorize`,
            token_endpoint: `${idp.baseUrl}/token`,
            // client_id is null → triggers dynamic registration.
            client_id: null,
            scope: "openid",
          },
        },
        template_snapshot: makeDynRegSnapshot(idp.baseUrl),
      })
      .returning();
    if (!row) throw new Error("seed connector failed");

    const before = idp.requestLog().length;

    const res = await fetch(`${server.baseUrl}/v1/connectors/${row.id}/oauth/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.apiKey}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_url: string; state: string };
    expect(typeof body.authorization_url).toBe("string");
    expect(typeof body.state).toBe("string");

    // Verify /register was called.
    const log = idp.requestLog().slice(before);
    const registerIdx = log.indexOf("POST /register");
    expect(registerIdx).toBeGreaterThanOrEqual(0);

    // /register must appear before any authorize redirect in the log.
    // (The engine calls the IdP's /authorize to build the URL, so the
    // discovery + /register calls precede the /authorize fetch.)
    const authorizeIdx = log.findIndex((e) => e.includes("/authorize") || e.includes("GET /a"));
    // The route builds the authorization URL client-side (buildAuthorizationUrl)
    // without fetching /authorize — so we just assert /register was hit and
    // the response has an authorization_url pointing at the IdP.
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(body.authorization_url).toContain(idp.baseUrl);
    // If /authorize was fetched, it must come after /register.
    if (authorizeIdx >= 0) {
      expect(registerIdx).toBeLessThan(authorizeIdx);
    }
  });

  test("credential is persisted with mode=oauth2_client after successful registration", async () => {
    idp.setRegisterStatus(201);
    const dynClientId = `dyn-persist-${Date.now()}`; // allow-wall-clock: unique client id per test run
    idp.setClientId(dynClientId);

    const [row] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug: `dynreg-persist-${Date.now()}`, // allow-wall-clock: unique slug per test run
        display_name: "DynReg Persist Test",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://example.test",
        config: {
          oauth: {
            issuer_url: idp.baseUrl,
            authorization_endpoint: `${idp.baseUrl}/authorize`,
            token_endpoint: `${idp.baseUrl}/token`,
            client_id: null,
            scope: "openid",
          },
        },
        template_snapshot: makeDynRegSnapshot(idp.baseUrl),
      })
      .returning();
    if (!row) throw new Error("seed connector failed");

    const res = await fetch(`${server.baseUrl}/v1/connectors/${row.id}/oauth/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.apiKey}` },
    });
    expect(res.status).toBe(200);

    // Assert credential row.
    const credRows = await server.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, server.tenantId), eq(credentials.connector_id, row.id)));
    expect(credRows.length).toBe(1);
    expect(credRows[0]!.mode).toBe("oauth2_client");

    // Assert the connector config was updated with the resolved client_id.
    const updatedRows = await server.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, row.id))
      .limit(1);
    const updatedConfig = updatedRows[0]?.config as Record<string, unknown>;
    const updatedOauth = updatedConfig?.oauth as Record<string, unknown> | undefined;
    expect(updatedOauth?.client_id).toBe(dynClientId);

    // Assert audit row.
    const auditRows = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "oauth_client.registered"),
          eq(auditLog.resource_id, row.id),
        ),
      );
    expect(auditRows.length).toBe(1);
    const meta = auditRows[0]!.metadata as Record<string, unknown>;
    expect(typeof meta.issuer_url_host).toBe("string");
    expect(meta.issuer_url_host).not.toContain("://");
    expect(typeof meta.registration_endpoint_host).toBe("string");
    expect(meta.registration_endpoint_host).not.toContain("://");
  });

  test("registration failure → route error and oauth_client.registration_failed audit row", async () => {
    idp.setRegisterStatus(400);

    const [row] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug: `dynreg-fail-${Date.now()}`, // allow-wall-clock: unique slug per test run
        display_name: "DynReg Fail Test",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://example.test",
        config: {
          oauth: {
            issuer_url: idp.baseUrl,
            authorization_endpoint: `${idp.baseUrl}/authorize`,
            token_endpoint: `${idp.baseUrl}/token`,
            client_id: null,
            scope: "openid",
          },
        },
        template_snapshot: makeDynRegSnapshot(idp.baseUrl),
      })
      .returning();
    if (!row) throw new Error("seed connector failed");

    const res = await fetch(`${server.baseUrl}/v1/connectors/${row.id}/oauth/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.apiKey}` },
    });

    // Route should return a non-2xx error.
    expect(res.status).toBeGreaterThanOrEqual(400);

    // No credential should be persisted.
    const credRows = await server.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, server.tenantId), eq(credentials.connector_id, row.id)));
    expect(credRows.length).toBe(0);

    // Audit failure row must exist.
    const auditRows = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "oauth_client.registration_failed"),
          eq(auditLog.resource_id, row.id),
        ),
      );
    expect(auditRows.length).toBe(1);
    const meta = auditRows[0]!.metadata as Record<string, unknown>;
    expect(typeof meta.error_code).toBe("string");
    expect((meta.error_code as string).length).toBeGreaterThan(0);

    // Reset for other tests.
    idp.setRegisterStatus(201);
  });

  test("wrong-tenant request returns 404 (connector not visible to other tenant)", async () => {
    // Seed a connector for tenant A (the server's tenant).
    const [row] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug: `dynreg-tenant-iso-${Date.now()}`, // allow-wall-clock: unique slug per test run
        display_name: "DynReg Tenant Isolation",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://example.test",
        config: {
          oauth: {
            issuer_url: idp.baseUrl,
            client_id: null,
          },
        },
        template_snapshot: makeDynRegSnapshot(idp.baseUrl),
      })
      .returning();
    if (!row) throw new Error("seed connector failed");

    // Create a second HTTP test server (different tenant, different API key).
    const { createHttpTestServer } = await import("../../tests/setup.ts");
    const server2 = await createHttpTestServer("oauth-dynreg-iso");
    try {
      // Tenant B tries to start oauth on tenant A's connector.
      const res = await fetch(`${server2.baseUrl}/v1/connectors/${row.id}/oauth/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${server2.apiKey}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await server2.cleanup();
    }
  });
});
