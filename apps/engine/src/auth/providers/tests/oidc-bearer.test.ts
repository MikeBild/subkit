import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import type { OidcBearerProviderConfig } from "../../../config/schema.ts";
import type { Db } from "../../../db/client.ts";
import {
  productIdentityTombstones,
  tenants,
  userIdentities,
  users,
} from "../../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../../db/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import {
  addUnpublishedKey,
  BEARER_NOW_SECONDS,
  startTestBearerIssuer,
  type TestBearerIssuer,
  unsignedToken,
} from "../../../test-helpers/oidc-bearer-issuer.ts";
import { productSubjectDigest } from "../../identity-link.ts";
import { AuthProviderRegistry } from "../../registry.ts";
import { type AuthDenial, isAuthDenial, type ResolvedPrincipal } from "../../types.ts";
import { createOidcBearerProvider, flushOidcBearerKeys } from "../oidc-bearer.ts";

let testDb: TestDb;
let db: Db;
let tenantId: string;
let issuer: TestBearerIssuer;
let config: OidcBearerProviderConfig[];
const nextUuid = createDeterministicUuidFactory(41);

function provider(extra: { jwksCooldownMs?: number } = {}) {
  return createOidcBearerProvider({
    db,
    providers: () => config,
    now: () => new Date(FROZEN_NOW),
    ...extra,
  });
}

function bearer(token: string, url = "https://engine.example.test/v1/executions"): Request {
  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

async function resolve(token: string, extra: { jwksCooldownMs?: number } = {}) {
  return provider(extra).resolve(bearer(token));
}

function expectDenied(result: ResolvedPrincipal | AuthDenial | null, reason?: string) {
  expect(isAuthDenial(result)).toBe(true);
  if (reason) expect((result as AuthDenial).reason).toBe(reason);
}

beforeAll(async () => {
  testDb = await createTestDb("oidc_bearer");
  db = testDb.db;
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: "bearer-tenant", display_name: "Bearer" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  issuer = await startTestBearerIssuer();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await issuer?.stop();
  if (testDb) await testDb.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

beforeEach(() => {
  flushOidcBearerKeys();
  config = [issuer.provider({ tenant_slug: "bearer-tenant" })];
});

describe("oidc_bearer verification", () => {
  test("a valid issuer token resolves a product user principal with an external_bearer source", async () => {
    const sub = nextUuid();
    const result = await resolve(await issuer.mint({ sub }));
    expect(isAuthDenial(result)).toBe(false);
    const principal = result as ResolvedPrincipal;
    expect(principal.kind).toBe("user");
    expect(principal.product_id).toBe("tekit");
    expect(principal.provider).toBe("tekit-supabase");
    expect(principal.tenant_id).toBe(tenantId);
    expect(principal.subject).toBe(sub);
    expect(principal.roles).toEqual(["member"]);
    expect(principal.email).toBeUndefined();
    expect(principal.scopes).toBeUndefined();
    expect(principal.auth_source).toEqual({
      kind: "external_bearer",
      provider_id: "tekit-supabase",
      identity_id: expect.any(String),
      issued_at: new Date(BEARER_NOW_SECONDS * 1000).toISOString(),
      expires_at: new Date((BEARER_NOW_SECONDS + 3600) * 1000).toISOString(),
    });
  });

  test("an expired token is denied", async () => {
    const token = await issuer.mint(
      { sub: nextUuid() },
      { issuedAt: BEARER_NOW_SECONDS - 7200, expiresIn: 3600 },
    );
    expectDenied(await resolve(token), "ERR_JWT_EXPIRED");
  });

  test("a token for another audience is denied", async () => {
    const token = await issuer.mint({ sub: nextUuid() }, { audience: "service_role" });
    expectDenied(await resolve(token), "ERR_JWT_CLAIM_VALIDATION_FAILED");
  });

  test("a token whose issuer matches no provider is not claimed", async () => {
    const token = await issuer.mint({ sub: nextUuid() }, { issuer: "https://other.example.test" });
    expect(await resolve(token)).toBeNull();
    expect(provider().claims(bearer(token))).toBe(false);
  });

  test("an HS256 token from the configured issuer is denied", async () => {
    const token = await new SignJWT({ sub: nextUuid(), role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer.issuer)
      .setAudience("authenticated")
      .setIssuedAt(BEARER_NOW_SECONDS)
      .setExpirationTime(BEARER_NOW_SECONDS + 600)
      .sign(new TextEncoder().encode("shared-secret-shared-secret-32by"));
    expectDenied(await resolve(token), "algorithm_not_allowed");
  });

  test("an unsigned alg none token from the configured issuer is denied", async () => {
    const token = unsignedToken({
      iss: issuer.issuer,
      aud: "authenticated",
      sub: nextUuid(),
      role: "authenticated",
      iat: BEARER_NOW_SECONDS,
      exp: BEARER_NOW_SECONDS + 600,
    });
    expectDenied(await resolve(token), "algorithm_not_allowed");
  });

  test("a token signed by an unknown kid is denied", async () => {
    const key = await addUnpublishedKey();
    const token = await issuer.mint({ sub: nextUuid() }, { kid: "ghost", key });
    expectDenied(await resolve(token), "ERR_JWKS_NO_MATCHING_KEY");
  });

  test("a token whose signature does not match the published key is denied", async () => {
    const key = await addUnpublishedKey();
    const token = await issuer.mint({ sub: nextUuid() }, { kid: "key-1", key });
    expectDenied(await resolve(token), "ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
  });

  test("a token without role authenticated is denied", async () => {
    const token = await issuer.mint({ sub: nextUuid(), role: "anon" });
    expectDenied(await resolve(token), "required_claim_mismatch");
  });

  test("an anonymous subject is denied", async () => {
    const token = await issuer.mint({ sub: nextUuid(), is_anonymous: true });
    expectDenied(await resolve(token), "anonymous_subject");
  });

  test("a non-UUID subject is denied", async () => {
    const token = await issuer.mint({ sub: "apple|123" });
    expectDenied(await resolve(token), "subject_not_uuid");
  });

  describe("required_claims app_metadata.provider equals apple", () => {
    beforeEach(() => {
      config = [
        issuer.provider({
          tenant_slug: "bearer-tenant",
          required_claims: [
            { path: "role", equals: "authenticated" },
            { path: "app_metadata.provider", equals: "apple" },
          ],
        }),
      ];
    });

    async function identityCount(sub: string): Promise<number> {
      const rows = await db
        .select()
        .from(userIdentities)
        .where(and(eq(userIdentities.tenant_id, tenantId), eq(userIdentities.subject, sub)));
      return rows.length;
    }

    test("a token without the claim is denied and provisions nothing", async () => {
      const sub = nextUuid();
      expectDenied(await resolve(await issuer.mint({ sub })), "required_claim_missing");
      expect(await identityCount(sub)).toBe(0);
    });

    test("a token with a different claim value is denied and provisions nothing", async () => {
      const sub = nextUuid();
      expectDenied(
        await resolve(await issuer.mint({ sub, app_metadata: { provider: "email" } })),
        "required_claim_mismatch",
      );
      expect(await identityCount(sub)).toBe(0);
    });

    test("a token with the matching claim resolves and provisions the identity", async () => {
      const sub = nextUuid();
      const accepted = await resolve(
        await issuer.mint({ sub, app_metadata: { provider: "apple" } }),
      );
      expect(isAuthDenial(accepted)).toBe(false);
      expect((accepted as ResolvedPrincipal).subject).toBe(sub);
      expect(await identityCount(sub)).toBe(1);
    });
  });

  describe("a product claim next to the sign-in method", () => {
    beforeEach(() => {
      config = [
        issuer.provider({
          tenant_slug: "bearer-tenant",
          required_claims: [
            { path: "app_metadata.provider", equals: "apple" },
            { path: "app_metadata.tekit", equals: true },
          ],
        }),
      ];
    });

    test("a token of another app on the same issuer is denied", async () => {
      expectDenied(
        await resolve(await issuer.mint({ sub: nextUuid(), app_metadata: { provider: "apple" } })),
        "required_claim_missing",
      );
      expectDenied(
        await resolve(
          await issuer.mint({
            sub: nextUuid(),
            app_metadata: { provider: "apple", tekit: "true", products: ["tekit"] },
          }),
        ),
        "required_claim_mismatch",
      );
    });

    test("a token carrying the product claim resolves", async () => {
      const accepted = await resolve(
        await issuer.mint({ sub: nextUuid(), app_metadata: { provider: "apple", tekit: true } }),
      );
      expect(isAuthDenial(accepted)).toBe(false);
    });
  });

  test("the token query parameter is never read", async () => {
    const token = await issuer.mint({ sub: nextUuid() });
    const req = new Request(`https://engine.example.test/v1/budget?token=${token}`);
    expect(await provider().resolve(req)).toBeNull();
  });

  test("SubKit credentials are never claimed by the bearer provider", async () => {
    const bearerProvider = provider();
    for (const token of [
      "wf_live_abcdefgh_0123456789abcdef0123456789abcdef",
      "wf_portal_abcdefgh_0123456789abcdef",
      "wf_mcp_0123456789abcdef0123456789abcdef",
      await new SignJWT({ sub: nextUuid() })
        .setProtectedHeader({ alg: "HS256", typ: "subkit-tx+jwt" })
        .setIssuer("https://subkit.example.test")
        .sign(new TextEncoder().encode("exchange-secret-exchange-secret-")),
    ]) {
      expect(bearerProvider.claims(bearer(token))).toBe(false);
      expect(await bearerProvider.resolve(bearer(token))).toBeNull();
    }
  });
});

describe("oidc_bearer key set caching", () => {
  test("a second request reuses the cached key set without fetching", async () => {
    const before = issuer.jwksFetches();
    expect(isAuthDenial(await resolve(await issuer.mint({ sub: nextUuid() })))).toBe(false);
    const afterFirst = issuer.jwksFetches();
    expect(afterFirst).toBe(before + 1);
    expect(isAuthDenial(await resolve(await issuer.mint({ sub: nextUuid() })))).toBe(false);
    expect(issuer.jwksFetches()).toBe(afterFirst);
  });

  test("an unknown kid triggers one refetch and the cooldown suppresses another", async () => {
    expect(isAuthDenial(await resolve(await issuer.mint({ sub: nextUuid() })))).toBe(false);
    const warm = issuer.jwksFetches();
    const ghost = await issuer.mint(
      { sub: nextUuid() },
      { kid: "ghost", key: await addUnpublishedKey() },
    );
    expectDenied(await resolve(ghost));
    expectDenied(await resolve(ghost));
    expect(issuer.jwksFetches()).toBe(warm);
  });

  test("a rotated key is picked up by one refetch once the cooldown has passed", async () => {
    const options = { jwksCooldownMs: 0 };
    expect(isAuthDenial(await resolve(await issuer.mint({ sub: nextUuid() }), options))).toBe(
      false,
    );
    const warm = issuer.jwksFetches();
    const kid = await issuer.rotate();
    const rotated = await resolve(await issuer.mint({ sub: nextUuid() }, { kid }), options);
    expect(isAuthDenial(rotated)).toBe(false);
    expect(issuer.jwksFetches()).toBe(warm + 1);
  });

  test("a provider configuration change flushes the cached key set", async () => {
    expect(isAuthDenial(await resolve(await issuer.mint({ sub: nextUuid() })))).toBe(false);
    const warm = issuer.jwksFetches();
    config = [issuer.provider({ tenant_slug: "bearer-tenant", clock_tolerance_s: 10 })];
    expect(isAuthDenial(await resolve(await issuer.mint({ sub: nextUuid() })))).toBe(false);
    expect(issuer.jwksFetches()).toBe(warm + 1);
  });
});

describe("oidc_bearer product identity provisioning", () => {
  test("the first token creates one placeholder user and never links by email", async () => {
    const sub = nextUuid();
    await db.insert(users).values({
      tenant_id: tenantId,
      email: "person@example.test",
      role_id: await builtinRoleId(db, "admin"),
    });
    const principal = (await resolve(
      await issuer.mint({ sub, email: "person@example.test" }),
    )) as ResolvedPrincipal;
    const [row] = await db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenantId), eq(users.id, principal.id)));
    expect(row?.email).toBe(`tekit-supabase:${sub}@invalid`);
    const [identity] = await db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.tenant_id, tenantId), eq(userIdentities.subject, sub)));
    expect(identity?.product_id).toBe("tekit");
    expect(identity?.issuer_url).toBe(issuer.issuer);
    const again = (await resolve(await issuer.mint({ sub }))) as ResolvedPrincipal;
    expect(again.id).toBe(principal.id);
  });

  test("concurrent first requests of one subject create exactly one user", async () => {
    const sub = nextUuid();
    const token = await issuer.mint({ sub });
    const results = await Promise.all(Array.from({ length: 12 }, () => resolve(token)));
    const ids = new Set(results.map((result) => (result as ResolvedPrincipal).id));
    expect(ids.size).toBe(1);
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenantId), eq(users.email, `tekit-supabase:${sub}@invalid`)));
    expect(rows).toHaveLength(1);
  });

  test("a disabled user is denied", async () => {
    const sub = nextUuid();
    const principal = (await resolve(await issuer.mint({ sub }))) as ResolvedPrincipal;
    await db
      .update(users)
      .set({ status: "disabled" })
      .where(and(eq(users.tenant_id, tenantId), eq(users.id, principal.id)));
    expectDenied(await resolve(await issuer.mint({ sub })), "identity_unavailable");
  });

  test("a tombstoned subject is denied for tokens issued before erasure and not re-created", async () => {
    const sub = nextUuid();
    await db.insert(productIdentityTombstones).values({
      tenant_id: tenantId,
      provider_id: "tekit-supabase",
      issuer_url: issuer.issuer,
      subject_sha256: productSubjectDigest(sub),
      erased_at: new Date(FROZEN_NOW),
    });
    expectDenied(await resolve(await issuer.mint({ sub })), "identity_erased");
    const rows = await db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.tenant_id, tenantId), eq(userIdentities.subject, sub)));
    expect(rows).toHaveLength(0);
  });

  test("an unknown tenant slug is denied", async () => {
    config = [issuer.provider({ tenant_slug: "missing-tenant" })];
    expectDenied(await resolve(await issuer.mint({ sub: nextUuid() })), "tenant_unavailable");
  });
});

describe("registry no-fallback guarantee", () => {
  test("a denied bearer token is never rescued by a later provider", async () => {
    const registry = new AuthProviderRegistry();
    registry.register(provider());
    registry.register({
      name: "browser_session",
      capabilities: {
        human: true,
        machine: false,
        interactive: false,
        refresh: false,
        revoke: true,
      },
      resolve: async () => ({
        provider: "browser_session",
        kind: "user",
        id: nextUuid(),
        tenant_id: tenantId,
        roles: ["admin"],
      }),
    });
    const expired = await issuer.mint(
      { sub: nextUuid() },
      { issuedAt: BEARER_NOW_SECONDS - 7200, expiresIn: 3600 },
    );
    const req = new Request("https://engine.example.test/v1/executions", {
      headers: { authorization: `Bearer ${expired}`, cookie: "subkit_session=valid" },
    });
    expectDenied(await registry.resolve(req));
  });

  test("a claiming provider that throws becomes a denial instead of falling through", async () => {
    const registry = new AuthProviderRegistry();
    registry.register({
      name: "claiming",
      capabilities: {
        human: true,
        machine: false,
        interactive: false,
        refresh: false,
        revoke: false,
      },
      claims: () => true,
      resolve: async () => {
        throw new Error("jwks unreachable");
      },
    });
    registry.register({
      name: "fallback",
      capabilities: {
        human: true,
        machine: false,
        interactive: false,
        refresh: false,
        revoke: false,
      },
      resolve: async () => ({
        provider: "fallback",
        kind: "user",
        id: nextUuid(),
        tenant_id: tenantId,
        roles: ["admin"],
      }),
    });
    expectDenied(
      await registry.resolve(new Request("https://engine.example.test/")),
      "provider_error",
    );
  });

  test("an unclaimed request still falls through to later providers", async () => {
    const registry = new AuthProviderRegistry();
    registry.register(provider());
    registry.register({
      name: "fallback",
      capabilities: {
        human: true,
        machine: false,
        interactive: false,
        refresh: false,
        revoke: false,
      },
      resolve: async () => ({
        provider: "fallback",
        kind: "user",
        id: nextUuid(),
        tenant_id: tenantId,
        roles: ["admin"],
      }),
    });
    const resolved = await registry.resolve(bearer("wf_live_abcdefgh_0123456789abcdef"));
    expect((resolved as ResolvedPrincipal).provider).toBe("fallback");
  });
});
