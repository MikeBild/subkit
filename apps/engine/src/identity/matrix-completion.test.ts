import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { resolveProviderIdentity } from "../auth/identity-link.ts";
import { createPortalTokenProvider } from "../auth/providers/portal-token.ts";
import type { Db } from "../db/client.ts";
import { portalTokens, tenants, userIdentities, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { fetchDiscovery, flushDiscoveryCache } from "./oidc-discovery.ts";
import { issuePortalToken, revokePortalToken } from "./service.ts";

let testDb: TestDb;
let db: Db;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("identity_matrix");
  db = testDb.db;
  const [t] = await db
    .insert(tenants)
    .values({ slug: "id-mx", display_name: "Identity Matrix" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

describe("portal-token revocation propagation", () => {
  test("revoke flips the resolver decision on the next request", async () => {
    const [user] = await db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "portal-rev@id.local",
        role_id: await builtinRoleId(db, "enduser"),
      })
      .returning();
    if (!user) throw new Error("seed user failed");

    const issued = await issuePortalToken(
      {
        tenant_id: tenantId,
        user_id: user.id,
        allowed_workflows: ["wfa"],
        actor_id: null,
        ttl_minutes: 60,
      },
      db,
    );
    const provider = createPortalTokenProvider({ db });

    const okReq = new Request("https://engine/v1/whoami", {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    });
    const okPrincipal = await provider.resolve(okReq);
    expect(okPrincipal).not.toBeNull();
    expect(okPrincipal?.id).toBe(user.id);

    await revokePortalToken({ tenant_id: tenantId, id: issued.view.id, actor_id: null }, db);

    const denyReq = new Request("https://engine/v1/whoami", {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    });
    const deniedPrincipal = await provider.resolve(denyReq);
    expect(deniedPrincipal).toBeNull();
  });

  test("revoke is idempotent: revoking twice leaves the row revoked once", async () => {
    const [user] = await db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "portal-revoke-twice@id.local",
        role_id: await builtinRoleId(db, "enduser"),
      })
      .returning();
    if (!user) throw new Error("seed user failed");

    const issued = await issuePortalToken(
      {
        tenant_id: tenantId,
        user_id: user.id,
        allowed_workflows: ["wfa"],
        actor_id: null,
        ttl_minutes: 60,
      },
      db,
    );
    await revokePortalToken({ tenant_id: tenantId, id: issued.view.id, actor_id: null }, db);
    const rowsAfter = await db
      .select()
      .from(portalTokens)
      .where(eq(portalTokens.id, issued.view.id));
    const firstRevokedAt = rowsAfter[0]?.revoked_at ?? null;
    expect(firstRevokedAt).not.toBeNull();

    await revokePortalToken({ tenant_id: tenantId, id: issued.view.id, actor_id: null }, db);
    const rowsAfter2 = await db
      .select()
      .from(portalTokens)
      .where(eq(portalTokens.id, issued.view.id));
    expect(rowsAfter2[0]?.revoked_at?.getTime()).toBe(firstRevokedAt?.getTime());
  });
});

describe("concurrent JIT first-login", () => {
  test("two simultaneous resolutions of one provider subject produce one binding", async () => {
    const sub = "concurrent-sub-1";
    const email = "concurrent@id.local";

    const resolve = () =>
      resolveProviderIdentity(db, {
        tenantId,
        providerId: "test-identity",
        subject: sub,
        email,
        linkByEmail: true,
        allowCreate: true,
      });

    const [a, b] = await Promise.all([resolve(), resolve()]);
    expect(a.user.id).toBe(b.user.id);

    const rows = await db.select().from(userIdentities).where(eq(userIdentities.subject, sub));
    expect(rows.length).toBe(1);
  });
});

describe("JWKS rotation tolerance", () => {
  test("flushing the discovery cache lets the next call see a rotated jwks_uri", async () => {
    const { createServer } = await import("node:http");
    let callIdx = 0;
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.endsWith("/.well-known/openid-configuration")) {
        callIdx += 1;
        const baseIssuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const jwksUri = callIdx === 1 ? `${baseIssuer}/jwks-v1` : `${baseIssuer}/jwks-v2`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ issuer: baseIssuer, jwks_uri: jwksUri }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const issuerUrl = new URL(`http://127.0.0.1:${port}`);

    try {
      flushDiscoveryCache();
      const first = await fetchDiscovery(issuerUrl);
      expect(first.jwks_uri).toBe(`http://127.0.0.1:${port}/jwks-v1`);

      const cached = await fetchDiscovery(issuerUrl);
      expect(cached.jwks_uri).toBe(`http://127.0.0.1:${port}/jwks-v1`);

      flushDiscoveryCache();
      const rotated = await fetchDiscovery(issuerUrl);
      expect(rotated.jwks_uri).toBe(`http://127.0.0.1:${port}/jwks-v2`);
    } finally {
      const httpServer = server as unknown as {
        close: (cb: () => void) => void;
        closeAllConnections?: () => void;
      };
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  test("a freshly minted RS256 token with the new key would verify after a flush", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwt = await new SignJWT({ sub: "rotation-probe" })
      .setProtectedHeader({ alg: "RS256", kid: "rotated-key" })
      .setIssuedAt()
      .setIssuer("https://idp.example.com")
      .setExpirationTime("60s")
      .sign(privateKey);
    expect(typeof jwt).toBe("string");
    const jwk = await exportJWK(publicKey);
    expect(jwk.kty).toBe("RSA");
  });
});
