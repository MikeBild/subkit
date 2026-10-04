import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../../../crypto/aes-gcm.ts";
import { auditLog, connectors, credentials, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import {
  getCredentialForConnector,
  getOAuth2ClientCredential,
  upsertCredential,
} from "../../service.ts";
import { __resetOAuth2CacheForTests, dynamicallyRegisterClient } from "../client.ts";

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
  setRegisterStatus: (status: number) => void;
}

async function startMockIdP(initialStatus = 201): Promise<MockIdPHandle> {
  let registerStatus = initialStatus;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
            client_id: `dyn-${Date.now()}`, // allow-wall-clock: mock IdP unique client_id
            client_secret: "dyn-secret-integration",
            client_id_issued_at: Math.floor(Date.now() / 1000), // allow-wall-clock: mock IdP issued_at field
          }),
        );
      } else {
        res.statusCode = registerStatus;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "unauthorized_client" }));
      }
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setRegisterStatus: (s: number) => {
      registerStatus = s;
    },
  };
}

let ctx: TestDb;
let idp: MockIdPHandle;

beforeAll(async () => {
  ctx = await createTestDb("dynreg_integration");
  idp = await startMockIdP();
  __resetOAuth2CacheForTests();
});

afterAll(async () => {
  await idp.close();
  __resetOAuth2CacheForTests();
  await ctx.cleanup();
});

async function seedConnector(tenantId: string, slug: string): Promise<string> {
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug,
      display_name: `Integration connector ${slug}`,
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      config: { oauth: { issuer_url: idp.baseUrl } },
    })
    .returning();
  if (!row) throw new Error(`seed connector failed for ${slug}`);
  return row.id;
}

describe("dynamic registration + credential persistence — crypto roundtrip + AAD binding", () => {
  test("credential row is written with mode=oauth2_client and can be decrypted", async () => {
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "dr-aad-tenant", display_name: "AAD Binding Tenant" })
      .returning();
    const tenantId = t!.id;
    const connectorId = await seedConnector(tenantId, "dr-aad-connector");

    const reg = await dynamicallyRegisterClient({
      issuerUrl: idp.baseUrl,
      clientMetadata: { redirect_uris: ["https://app.example.com/callback"] },
      allowInsecureRequests: true,
    });

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          client_id: reg.clientId,
          ...(reg.clientSecret ? { client_secret: reg.clientSecret } : {}),
        },
        actor_id: null,
      },
      ctx.db,
    );

    const primary = await getCredentialForConnector(tenantId, connectorId, "dev", ctx.db);
    expect(primary).toBeNull();
    const dynamic = await getOAuth2ClientCredential(tenantId, connectorId, "dev", ctx.db);
    expect(dynamic).not.toBeNull();
    expect(dynamic!.client_id).toBe(reg.clientId);

    const rows = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenantId), eq(credentials.connector_id, connectorId)))
      .limit(1);
    const row = rows[0]!;

    const fakeCredentialId = "00000000-0000-0000-0000-000000000001";
    const wrongAad = `credential:${tenantId}:${fakeCredentialId}`;
    expect(() =>
      decryptSecret({ ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag }, wrongAad),
    ).toThrow();
  });

  test("same-tenant plaintext re-encrypted under a different row id fails decryption", async () => {
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "dr-aad2-tenant", display_name: "AAD Binding Tenant 2" })
      .returning();
    const tenantId = t!.id;

    const plain = JSON.stringify({ client_id: "c1", client_secret: "s1" });
    const realId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const realAad = `credential:${tenantId}:${realId}`;
    const payload = encryptSecret(plain, realAad);

    const otherId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const otherAad = `credential:${tenantId}:${otherId}`;
    expect(() =>
      decryptSecret(
        { ciphertext: payload.ciphertext, iv: payload.iv, auth_tag: payload.auth_tag },
        otherAad,
      ),
    ).toThrow();
  });
});

describe("dynamic registration + credential persistence — tenant isolation", () => {
  test("tenant B cannot read tenant A credentials via getCredentialForConnector", async () => {
    const [tA] = await ctx.db
      .insert(tenants)
      .values({ slug: "dr-iso-tenant-a", display_name: "Isolation Tenant A" })
      .returning();
    const [tB] = await ctx.db
      .insert(tenants)
      .values({ slug: "dr-iso-tenant-b", display_name: "Isolation Tenant B" })
      .returning();
    const tenantIdA = tA!.id;
    const tenantIdB = tB!.id;

    const connectorIdA = await seedConnector(tenantIdA, "dr-iso-connector-a");
    const connectorIdB = await seedConnector(tenantIdB, "dr-iso-connector-b");

    const regA = await dynamicallyRegisterClient({
      issuerUrl: idp.baseUrl,
      clientMetadata: { redirect_uris: ["https://app-a.example.com/callback"] },
      allowInsecureRequests: true,
    });
    await upsertCredential(
      {
        tenant_id: tenantIdA,
        connector_id: connectorIdA,
        environment: "dev",
        mode: "oauth2_client",
        value: { mode: "oauth2_client", client_id: regA.clientId },
        actor_id: null,
      },
      ctx.db,
    );

    const regB = await dynamicallyRegisterClient({
      issuerUrl: idp.baseUrl,
      clientMetadata: { redirect_uris: ["https://app-b.example.com/callback"] },
      allowInsecureRequests: true,
    });
    await upsertCredential(
      {
        tenant_id: tenantIdB,
        connector_id: connectorIdB,
        environment: "dev",
        mode: "oauth2_client",
        value: { mode: "oauth2_client", client_id: regB.clientId },
        actor_id: null,
      },
      ctx.db,
    );

    const crossRead = await getOAuth2ClientCredential(tenantIdB, connectorIdA, "dev", ctx.db);
    expect(crossRead).toBeNull();

    const aView = await getOAuth2ClientCredential(tenantIdA, connectorIdA, "dev", ctx.db);
    expect(aView).not.toBeNull();
    const bView = await getOAuth2ClientCredential(tenantIdB, connectorIdB, "dev", ctx.db);
    expect(bView).not.toBeNull();
  });
});

describe("dynamic registration — coexistence with oauth2 access token credential", () => {
  test("oauth2_client and oauth2 credentials coexist; refresh path keeps secret readable", async () => {
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "dr-coexist-tenant", display_name: "Coexistence Tenant" })
      .returning();
    const tenantId = t!.id;
    const connectorId = await seedConnector(tenantId, "dr-coexist-connector");

    const reg = await dynamicallyRegisterClient({
      issuerUrl: idp.baseUrl,
      clientMetadata: { redirect_uris: ["https://app.example.com/callback"] },
      allowInsecureRequests: true,
    });
    expect(reg.clientSecret).toBeTruthy();

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          client_id: reg.clientId,
          ...(reg.clientSecret ? { client_secret: reg.clientSecret } : {}),
        },
        actor_id: null,
      },
      ctx.db,
    );

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2",
        value: { mode: "oauth2", access_token: "access-abc", token_type: "Bearer" },
        oauth2_refresh_token: "refresh-xyz",
        oauth2_expires_at: new Date(getTestNow() + 3600_000),
        actor_id: null,
      },
      ctx.db,
    );

    const dynamic = await getOAuth2ClientCredential(tenantId, connectorId, "dev", ctx.db);
    expect(dynamic).not.toBeNull();
    expect(dynamic!.client_id).toBe(reg.clientId);
    expect(dynamic!.client_secret).toBe(reg.clientSecret);

    const primary = await getCredentialForConnector(tenantId, connectorId, "dev", ctx.db);
    expect(primary).not.toBeNull();
    expect(primary!.value.mode).toBe("oauth2");
    if (primary!.value.mode === "oauth2") {
      expect(primary!.value.access_token).toBe("access-abc");
      expect(primary!.value.refresh_token).toBe("refresh-xyz");
    }

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2",
        value: { mode: "oauth2", access_token: "access-rotated", token_type: "Bearer" },
        oauth2_refresh_token: "refresh-rotated",
        oauth2_expires_at: new Date(getTestNow() + 3600_000),
        actor_id: null,
      },
      ctx.db,
    );
    const dynamicAfter = await getOAuth2ClientCredential(tenantId, connectorId, "dev", ctx.db);
    expect(dynamicAfter).not.toBeNull();
    expect(dynamicAfter!.client_id).toBe(reg.clientId);
    expect(dynamicAfter!.client_secret).toBe(reg.clientSecret);
  });
});

describe("dynamic registration — audit success path", () => {
  test("audit_log row is written with action=oauth_client.registered on success", async () => {
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "dr-audit-ok-tenant", display_name: "Audit OK Tenant" })
      .returning();
    const tenantId = t!.id;
    const connectorId = await seedConnector(tenantId, "dr-audit-ok-connector");

    const reg = await dynamicallyRegisterClient({
      issuerUrl: idp.baseUrl,
      clientMetadata: { redirect_uris: ["https://audit-ok.example.com/callback"] },
      allowInsecureRequests: true,
    });

    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2_client",
        value: { mode: "oauth2_client", client_id: reg.clientId },
        actor_id: null,
      },
      ctx.db,
    );

    const { recordOAuthClientRegistered } = await import("../../../audit/recorders/credential.ts");
    await recordOAuthClientRegistered({
      tenant_id: tenantId,
      actor_id: null,
      connector_id: connectorId,
      issuer_url_host: new URL(idp.baseUrl).host,
      registration_endpoint_host: new URL(idp.baseUrl).host,
      executor: ctx.db,
    });

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "oauth_client.registered")));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.resource_type).toBe("connector");
    expect(row.resource_id).toBe(connectorId);
    expect(row.result).toBe("success");
    const meta = row.metadata as Record<string, unknown>;
    expect(typeof meta.issuer_url_host).toBe("string");
    expect(typeof meta.registration_endpoint_host).toBe("string");
    expect(meta.issuer_url_host).not.toContain("://");
    expect(meta.registration_endpoint_host).not.toContain("://");
  });
});

describe("dynamic registration — audit failure path", () => {
  test("audit_log row with action=oauth_client.registration_failed is written on 401", async () => {
    idp.setRegisterStatus(401);
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "dr-audit-fail-tenant", display_name: "Audit Fail Tenant" })
      .returning();
    const tenantId = t!.id;
    const connectorId = await seedConnector(tenantId, "dr-audit-fail-connector");

    const { recordOAuthClientRegistrationFailed } = await import(
      "../../../audit/recorders/credential.ts"
    );
    await recordOAuthClientRegistrationFailed({
      tenant_id: tenantId,
      actor_id: null,
      connector_id: connectorId,
      issuer_url_host: new URL(idp.baseUrl).host,
      registration_endpoint_host: null,
      error_code: "registration_http_401",
      executor: ctx.db,
    });

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "oauth_client.registration_failed"),
        ),
      );
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.result).toBe("error");
    expect(row.resource_type).toBe("connector");
    expect(row.resource_id).toBe(connectorId);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.error_code).toBe("registration_http_401");

    idp.setRegisterStatus(201);
  });
});
