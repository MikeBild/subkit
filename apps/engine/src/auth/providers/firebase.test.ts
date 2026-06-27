// Unit coverage for createFirebaseProvider.
//
// These tests exercise the stateless verify surface without a database or
// any network: the JWKS resolver is injected via `opts.jwks`, so real
// signatures are verified against a local key and no globalThis.fetch stub
// is needed (which would leak across concurrently-run test files). Contract:
//
//   - a non-JWT bearer (e.g. a subkit wf_* opaque key) declines without
//     ever touching the JWKS resolver or the DB.
//   - a missing bearer declines.
//   - a JWT-shaped token whose signature does not verify declines (null),
//     letting the registry fall through to the next provider.
//   - an empty project_id declines before any verification.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as jose from "jose";
import { auditLog, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createFirebaseProvider } from "./firebase.ts";

const PROJECT_ID = "subkit-auth-test";

function b64url(obj: unknown): string {
  return jose.base64url.encode(new TextEncoder().encode(JSON.stringify(obj)));
}

// A syntactically valid JWT (three non-empty base64url segments) whose
// signature cannot verify against any key.
function unsignedJwt(): string {
  const header = b64url({ alg: "RS256", kid: "missing", typ: "JWT" });
  const payload = b64url({
    sub: "firebase-user-1",
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
  });
  return `${header}.${payload}.AAAA`;
}

function dbThatThrows() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("DB must not be touched");
      },
    },
  ) as never;
}

describe("firebase provider — resolve", () => {
  test("non-JWT bearer declines without touching the JWKS resolver or DB", async () => {
    let jwksCalls = 0;
    const jwks: jose.JWTVerifyGetKey = async () => {
      jwksCalls += 1;
      throw new Error("JWKS resolver must not be called for a non-JWT bearer");
    };
    const provider = createFirebaseProvider({ projectId: PROJECT_ID, db: dbThatThrows(), jwks });

    const principal = await provider.resolve(
      new Request("http://127.0.0.1/v1/whoami", {
        headers: { authorization: "Bearer wf_live_not_a_jwt_opaque_key" },
      }),
    );

    expect(principal).toBeNull();
    expect(jwksCalls).toBe(0);
  });

  test("missing bearer declines", async () => {
    const provider = createFirebaseProvider({ projectId: PROJECT_ID, db: dbThatThrows() });
    const principal = await provider.resolve(new Request("http://127.0.0.1/v1/whoami"));
    expect(principal).toBeNull();
  });

  test("JWT with an unverifiable signature declines (resolver consulted, DB not)", async () => {
    // Inject a real local key; the token is signed with garbage ("AAAA"),
    // so jose rejects the signature and the provider swallows it → null,
    // without ever reaching the DB.
    const { publicKey } = await jose.generateKeyPair("RS256");
    let jwksCalls = 0;
    const jwks: jose.JWTVerifyGetKey = async () => {
      jwksCalls += 1;
      return publicKey;
    };
    const provider = createFirebaseProvider({ projectId: PROJECT_ID, db: dbThatThrows(), jwks });

    const principal = await provider.resolve(
      new Request("http://127.0.0.1/v1/whoami", {
        headers: { authorization: `Bearer ${unsignedJwt()}` },
      }),
    );

    expect(principal).toBeNull();
    expect(jwksCalls).toBeGreaterThan(0);
  });

  test("no project_id configured declines without consulting the resolver", async () => {
    let jwksCalls = 0;
    const jwks: jose.JWTVerifyGetKey = async () => {
      jwksCalls += 1;
      throw new Error("resolver must not be called without a project_id");
    };
    const provider = createFirebaseProvider({ projectId: "", db: dbThatThrows(), jwks });
    const principal = await provider.resolve(
      new Request("http://127.0.0.1/v1/whoami", {
        headers: { authorization: `Bearer ${unsignedJwt()}` },
      }),
    );
    expect(principal).toBeNull();
    expect(jwksCalls).toBe(0);
  });

  test("capabilities advertise a non-machine interactive human provider", () => {
    const provider = createFirebaseProvider({ projectId: PROJECT_ID });
    expect(provider.name).toBe("firebase");
    expect(provider.capabilities).toEqual({
      human: true,
      machine: false,
      interactive: true,
      refresh: false,
      revoke: false,
    });
  });
});

// N1 — Firebase account-link path: external_subject stamp + USER_IDENTITY_LINKED audit.
//
// When a user was previously created by email (e.g. via an admin invite) and
// later signs in via Firebase for the first time, the provider must:
//   1. Update the user row: set external_subject = JWT sub.
//   2. Write a USER_IDENTITY_LINKED audit row so an account-takeover via a
//      provider-side email collision is auditable.
//
// These tests FAIL if the `linkedUser` audit branch inside createFirebaseProvider
// is removed: external_subject would still be stamped (the UPDATE runs) but the
// audit row would not appear, causing the USER_IDENTITY_LINKED assertion to fail.
//
// Uses createTestDb so no globalThis.fetch stub is needed — the JWKS resolver
// is injected via opts.jwks (the test seam), letting us sign real RS256 JWTs
// with a local key pair.
describe("firebase provider — identity-linking path (N1)", () => {
  const FB_PROJECT_ID = "fb-link-test-project";
  const FB_TENANT_SLUG = "fb-link-default";
  const USER_EMAIL = "linked-user@fb-test.local";
  const FIREBASE_SUB = "firebase-uid-link-test-001";

  let testDb: TestDb;
  let tenantId: string;
  let existingUserId: string;
  let signingKey: CryptoKey;
  let verifyingKey: CryptoKey;

  beforeAll(async () => {
    testDb = await createTestDb("firebase-link");

    // Create the tenant that the Firebase provider will resolve by slug.
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: FB_TENANT_SLUG, display_name: "Firebase Link Test" })
      .returning();
    if (!tenant) throw new Error("seed tenant failed");
    tenantId = tenant.id;

    // User with email but no external_subject: this is the link target.
    const [user] = await testDb.db
      .insert(users)
      .values({ tenant_id: tenantId, email: USER_EMAIL, role: "member" })
      .returning();
    if (!user) throw new Error("seed user failed");
    existingUserId = user.id;

    // Generate a local RS256 key pair — no network required.
    const pair = await jose.generateKeyPair("RS256");
    signingKey = pair.privateKey;
    verifyingKey = pair.publicKey;
  });

  afterAll(async () => {
    if (testDb) await testDb.cleanup();
  });

  test("email-matched user gets external_subject stamped and USER_IDENTITY_LINKED audit row written", async () => {
    const token = await new jose.SignJWT({ email: USER_EMAIL })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(FIREBASE_SUB)
      .setIssuer(`https://securetoken.google.com/${FB_PROJECT_ID}`)
      .setAudience(FB_PROJECT_ID)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signingKey);

    // Inject the local verifying key — no JWKS discovery, no network.
    const jwks: jose.JWTVerifyGetKey = async () => verifyingKey;

    const provider = createFirebaseProvider({
      projectId: FB_PROJECT_ID,
      tenantSlug: FB_TENANT_SLUG,
      db: testDb.db,
      jwks,
    });

    const principal = await provider.resolve(
      new Request("http://127.0.0.1/v1/whoami", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    // Provider must resolve to the existing user, not create a new one.
    expect(principal).not.toBeNull();
    expect(principal?.id).toBe(existingUserId);
    expect(principal?.provider).toBe("firebase");
    expect(principal?.tenant_id).toBe(tenantId);

    // The user row must have external_subject stamped.
    const [refreshed] = await testDb.db.select().from(users).where(eq(users.id, existingUserId));
    expect(refreshed?.external_subject).toBe(FIREBASE_SUB);

    // USER_IDENTITY_LINKED audit row must be present with the correct shape.
    const auditRows = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "user.identity_linked"), eq(auditLog.resource_id, existingUserId)),
      );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.tenant_id).toBe(tenantId);
    const meta = auditRows[0]?.metadata as Record<string, unknown>;
    expect(meta.source).toBe("firebase");
    expect(meta.external_subject).toBe(FIREBASE_SUB);
  });

  test("new email (no existing user) creates a USER_CREATED row, not USER_IDENTITY_LINKED", async () => {
    const newSub = "firebase-uid-brand-new-002";
    const newEmail = "brand-new@fb-test.local";

    const token = await new jose.SignJWT({ email: newEmail })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(newSub)
      .setIssuer(`https://securetoken.google.com/${FB_PROJECT_ID}`)
      .setAudience(FB_PROJECT_ID)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signingKey);

    const jwks: jose.JWTVerifyGetKey = async () => verifyingKey;

    const provider = createFirebaseProvider({
      projectId: FB_PROJECT_ID,
      tenantSlug: FB_TENANT_SLUG,
      db: testDb.db,
      jwks,
    });

    const principal = await provider.resolve(
      new Request("http://127.0.0.1/v1/whoami", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect(principal).not.toBeNull();
    // Must be a new user, not the pre-seeded one.
    expect(principal?.id).not.toBe(existingUserId);

    // USER_IDENTITY_LINKED must NOT be emitted for a brand-new user.
    const linkedRows = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "user.identity_linked"),
          eq(auditLog.resource_id, principal?.id ?? ""),
        ),
      );
    expect(linkedRows.length).toBe(0);

    // USER_CREATED must be emitted instead.
    const createdRows = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "user.created"), eq(auditLog.resource_id, principal?.id ?? "")),
      );
    expect(createdRows.length).toBe(1);
  });
});
