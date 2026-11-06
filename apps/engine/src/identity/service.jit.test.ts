import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { type MockOidcHandle, startMockOidc } from "../auth/providers/tests/fixtures/mock-oidc.ts";
import { auditLog, tenants, userIdentities, users } from "../db/schema/index.ts";
import {
  createHttpTestServer,
  type HttpTestServer,
  loadAuthProvidersForTest,
} from "../http/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { flushDiscoveryCache } from "./oidc-discovery.ts";

let httpCtx: HttpTestServer;

let mockOidc: MockOidcHandle;

let privateKey: CryptoKey;

let publicKey: CryptoKey;

let mockKid: string;

beforeAll(async () => {
  httpCtx = await createHttpTestServer("identity-jit");
  mockOidc = await startMockOidc();

  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  mockKid = "test-key-1";
});

afterAll(async () => {
  flushDiscoveryCache();
  try {
    await loadAuthProvidersForTest(
      [{ protocol: "api_key", id: "api-key", label: "SubKit API key" }],
      httpCtx.testDb.url,
    );
  } catch {}
  try {
    await mockOidc?.stop();
  } catch {}
  if (httpCtx) await httpCtx.cleanup();
});

beforeAll(async () => {
  await httpCtx.db
    .insert(tenants)
    .values({ slug: "default", display_name: "Default" })
    .onConflictDoNothing()
    .returning();
});

afterEach(() => {
  flushDiscoveryCache();
});

async function postIdentitySession(identityToken: string) {
  return fetch(`${httpCtx.baseUrl}/v1/identity/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "test-identity", identity_token: identityToken }),
  });
}

async function configureOidc(issuerUrl: string): Promise<void> {
  await loadAuthProvidersForTest(
    [
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
      {
        protocol: "oidc",
        id: "test-identity",
        label: "Test identity",
        issuer_url: issuerUrl,
        client_id: issuerUrl === mockOidc.url ? "mock-client" : "subkit-cli",
        scopes: "openid profile email",
        tenant_slug: "default",
      },
    ],
    httpCtx.testDb.url,
  );
}

describe("JIT provisioning — happy path (scenario 3)", () => {
  test("valid id_token creates user row + issues API key + audit entries", async () => {
    const provider = mockOidc;

    const issued = provider.issueFor(
      { sub: "jit-sub-1", email: "jit-happy@test.local", email_verified: true },
      { state: "", redirect_uri: "http://127.0.0.1:0/callback" },
    );
    const tokenRes = await fetch(`${provider.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issued.code,
        client_id: "mock-client",
        redirect_uri: "http://127.0.0.1:0/callback",
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { id_token: string };
    const id_token = tokenBody.id_token;
    expect(typeof id_token).toBe("string");

    await configureOidc(provider.url);
    const res = await postIdentitySession(id_token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      api_key: string;
      principal_id: string;
      context_id: string;
    };
    expect(body.api_key).toMatch(/^wf_live_/);

    const identityRows = await httpCtx.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.subject, "jit-sub-1"));
    expect(identityRows).toHaveLength(1);
    if (!identityRows[0]) throw new Error("provider binding missing");
    const userRows = await httpCtx.db
      .select()
      .from(users)
      .where(eq(users.id, identityRows[0].user_id));
    expect(userRows[0]?.email).toBe("jit-happy@test.local");

    const auditRows = await httpCtx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor_id, body.principal_id));
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain("session.issued");
    expect(actions).toContain("user.logged_in");
  });
});

describe("JIT provisioning — duplicate-email collision (scenario 4)", () => {
  test("second login with same email but different sub attaches sub to existing user", async () => {
    const provider = mockOidc;

    const [existingUser] = await httpCtx.db
      .insert(users)
      .values({
        tenant_id: httpCtx.tenantId,
        email: "collide@test.local",
        role_id: await builtinRoleId(httpCtx.db, "member"),
      })
      .returning();
    if (!existingUser) throw new Error("seed user failed");

    const [defaultTenant] = await httpCtx.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "default"))
      .limit(1);
    if (!defaultTenant) throw new Error("default tenant missing");

    const [defaultUser] = await httpCtx.db
      .insert(users)
      .values({
        tenant_id: defaultTenant.id,
        email: "collide@test.local",
        role_id: await builtinRoleId(httpCtx.db, "member"),
      })
      .returning();
    if (!defaultUser) throw new Error("default user seed failed");

    const issued = provider.issueFor(
      { sub: "collide-sub-99", email: "collide@test.local", email_verified: true },
      { state: "", redirect_uri: "http://127.0.0.1:0/callback" },
    );
    const tokenRes = await fetch(`${provider.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issued.code,
        client_id: "mock-client",
        redirect_uri: "http://127.0.0.1:0/callback",
      }).toString(),
    });
    const tokenBody = (await tokenRes.json()) as { id_token: string };

    await configureOidc(provider.url);
    const res = await postIdentitySession(tokenBody.id_token);
    expect(res.status).toBe(200);

    const linked = await httpCtx.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, defaultUser.id));
    expect(linked[0]?.provider_id).toBe("test-identity");
    expect(linked[0]?.subject).toBe("collide-sub-99");

    const allForEmail = await httpCtx.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, defaultTenant.id), eq(users.email, "collide@test.local")));
    expect(allForEmail.length).toBe(1);
  });
});

describe("JIT provisioning — clock-skew tolerance (scenario 5)", () => {
  test("iat = now - 1s (one second in the past) is accepted", async () => {
    const provider = mockOidc;
    const issued = provider.issueFor(
      { sub: "clockskew-past", email: "clockskew-past@test.local" },
      { state: "", redirect_uri: "http://127.0.0.1:0/callback" },
    );
    const tokenRes = await fetch(`${provider.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issued.code,
        client_id: "mock-client",
        redirect_uri: "http://127.0.0.1:0/callback",
      }).toString(),
    });
    const tokenBody = (await tokenRes.json()) as { id_token: string };

    await configureOidc(provider.url);
    const res = await postIdentitySession(tokenBody.id_token);
    expect(res.status).toBe(200);
  });

  test("exp = now - 1s (expired by one second) is rejected", async () => {
    const { createServer } = await import("node:http");
    const { exportJWK } = await import("jose");

    const jwk = await exportJWK(publicKey);
    jwk.kid = mockKid;
    jwk.alg = "RS256";
    jwk.use = "sig";

    const jwksServer = createServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://localhost");
      if (url.pathname === "/.well-known/openid-configuration") {
        const base = `http://127.0.0.1:${(jwksServer.address() as { port: number }).port}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      } else if (url.pathname === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", () => resolve()));
    const { port } = jwksServer.address() as { port: number };
    const issuerBase = `http://127.0.0.1:${port}`;

    try {
      const nowSec = Math.floor(getTestNow() / 1000);
      const id_token = await new SignJWT({ sub: "expired-sub", email: "expired@test.local" })
        .setProtectedHeader({ alg: "RS256", kid: mockKid })
        .setIssuer(issuerBase)
        .setAudience("subkit-cli")
        .setIssuedAt(nowSec - 120)
        .setExpirationTime(nowSec - 1)
        .sign(privateKey);

      await configureOidc(issuerBase);
      const res = await postIdentitySession(id_token);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    }
  });
});

describe("JIT provisioning — issuer-mismatch rejection (scenario 6)", () => {
  test("assertion issuer mismatch returns 401", async () => {
    const { createServer } = await import("node:http");
    const { exportJWK } = await import("jose");

    const jwk = await exportJWK(publicKey);
    jwk.kid = mockKid;
    jwk.alg = "RS256";
    jwk.use = "sig";

    const realServer = createServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://localhost");
      const base = `http://127.0.0.1:${(realServer.address() as { port: number }).port}`;
      if (url.pathname === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      } else if (url.pathname === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => realServer.listen(0, "127.0.0.1", () => resolve()));
    const { port } = realServer.address() as { port: number };
    const discoveredIssuer = `http://127.0.0.1:${port}`;

    try {
      const nowSec = Math.floor(getTestNow() / 1000);
      const id_token = await new SignJWT({
        sub: "mismatch-sub",
        email: "mismatch@test.local",
      })
        .setProtectedHeader({ alg: "RS256", kid: mockKid })
        .setIssuer("https://evil.example.com")
        .setAudience("subkit-cli")
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + 600)
        .sign(privateKey);

      await configureOidc(discoveredIssuer);
      const res = await postIdentitySession(id_token);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => realServer.close(() => resolve()));
    }
  });
});

describe("JIT provisioning — token without sub (scenario 7)", () => {
  test("id_token missing sub claim returns 401", async () => {
    const { createServer } = await import("node:http");
    const { exportJWK } = await import("jose");

    const jwk = await exportJWK(publicKey);
    jwk.kid = mockKid;
    jwk.alg = "RS256";
    jwk.use = "sig";

    const noSubServer = createServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://localhost");
      const base = `http://127.0.0.1:${(noSubServer.address() as { port: number }).port}`;
      if (url.pathname === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      } else if (url.pathname === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => noSubServer.listen(0, "127.0.0.1", () => resolve()));
    const { port } = noSubServer.address() as { port: number };
    const issuerBase = `http://127.0.0.1:${port}`;

    try {
      const nowSec = Math.floor(getTestNow() / 1000);
      const id_token = await new SignJWT({ email: "nosub@test.local" })
        .setProtectedHeader({ alg: "RS256", kid: mockKid })
        .setIssuer(issuerBase)
        .setAudience("subkit-cli")
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + 600)
        .sign(privateKey);

      await configureOidc(issuerBase);
      const res = await postIdentitySession(id_token);
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => noSubServer.close(() => resolve()));
    }
  });
});
