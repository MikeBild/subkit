// portal_token auth provider — negative-path + lifecycle tests.
//
// The provider has five rejection paths ahead of the happy path: no
// token present, a non-portal-prefixed token (falls through silently
// so the registry can try the api-key provider next), prefix not
// found, hash mismatch, revoked, and expired. This file pins each one
// plus the allow-list normalization and enduser-email resolution the
// happy path depends on.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { auditLog, portalTokens, tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { generatePortalToken } from "../../../identity/portal-token.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import { createPortalTokenProvider } from "../portal-token.ts";

let testDb: TestDb;
let db: Db;
let tenantId: string;
let ownerId: string;

beforeAll(async () => {
  testDb = await createTestDb("portal_token_negative");
  db = testDb.db;
  const [t] = await db
    .insert(tenants)
    .values({ slug: "pt-neg", display_name: "Portal Token Negative" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
  const [u] = await db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "owner@pt.local",
      role_id: await builtinRoleId(db, "member"),
    })
    .returning();
  if (!u) throw new Error("seed user failed");
  ownerId = u.id;
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

function bearerReq(token: string): Request {
  return new Request("https://engine/v1/whoami", {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function seedToken(overrides: {
  revoked_at?: Date;
  expires_at?: Date;
  enduser_ref?: string;
  allowed_workflows?: string[];
}): Promise<{ plaintext: string; id: string }> {
  const issued = generatePortalToken();
  const [row] = await db
    .insert(portalTokens)
    .values({
      tenant_id: tenantId,
      enduser_ref: overrides.enduser_ref ?? ownerId,
      prefix: issued.prefix,
      token_sha256: issued.hash,
      allowed_workflows: overrides.allowed_workflows ?? ["*"],
      // Far-future stable date (year 2223) so "not expired" holds
      // against the real wall clock the provider reads internally —
      // FROZEN_NOW (2023) is already in the past by real time.
      expires_at: overrides.expires_at ?? new Date(8_000_000_000_000),
      ...(overrides.revoked_at !== undefined ? { revoked_at: overrides.revoked_at } : {}),
    })
    .returning();
  if (!row) throw new Error("seed portal token failed");
  return { plaintext: issued.plaintext, id: row.id };
}

describe("portal-token provider — negative paths", () => {
  test("no bearer/query token returns null", async () => {
    const provider = createPortalTokenProvider({ db });
    const req = new Request("https://engine/v1/whoami");
    expect(await provider.resolve(req)).toBeNull();
  });

  test("a token without the wf_portal_ prefix falls through silently", async () => {
    const provider = createPortalTokenProvider({ db });
    const foreign = "wf_live_someapikeylookingtoken12345";
    expect(await provider.resolve(bearerReq(foreign))).toBeNull();
  });

  test("prefix not found returns null", async () => {
    const provider = createPortalTokenProvider({ db });
    const fake = "wf_portal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(await provider.resolve(bearerReq(fake))).toBeNull();
  });

  test("hash mismatch (right prefix, tampered tail) returns null and audits denial", async () => {
    const issued = await seedToken({});
    const tail = "deadbeefdeadbeefdeadbeefdeadbeef"; // 32 hex-ish chars, definitely wrong
    const tampered = `${issued.plaintext.slice(0, 14)}${tail}`;
    const provider = createPortalTokenProvider({ db });
    const principal = await provider.resolve(bearerReq(tampered));
    expect(principal).toBeNull();

    // Poll for THIS test's audit row instead of draining the process-global
    // pending-writes set: under a full-suite run the drain awaits foreign
    // writes too, and one hung neighbor (poisoned pool) stalls it for the
    // whole test timeout.
    const denied = await waitFor(
      async () => {
        const rows = await db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, issued.id)));
        return rows.find((r) => r.action === "policy.denied" && r.reason === "hash_mismatch");
      },
      { label: "policy.denied hash_mismatch audit entry", sleepMs: 25 },
    );
    expect(denied.action).toBe("policy.denied");
  });

  test("revoked portal token returns null", async () => {
    const past = new Date(FROZEN_NOW - 60_000);
    const issued = await seedToken({ revoked_at: past });
    const provider = createPortalTokenProvider({ db });
    expect(await provider.resolve(bearerReq(issued.plaintext))).toBeNull();
  });

  test("expired portal token returns null", async () => {
    const past = new Date(FROZEN_NOW - 60_000);
    const issued = await seedToken({ expires_at: past });
    const provider = createPortalTokenProvider({ db });
    expect(await provider.resolve(bearerReq(issued.plaintext))).toBeNull();
  });
});

describe("portal-token provider — happy path + allow-list normalization", () => {
  test("resolves an enduser principal scoped to the token's tenant with email resolved", async () => {
    const issued = await seedToken({ allowed_workflows: ["wf-a", "wf-b"] });
    const provider = createPortalTokenProvider({ db });
    const principal = await provider.resolve(bearerReq(issued.plaintext));
    expect(principal).not.toBeNull();
    expect(principal?.kind).toBe("user");
    expect(principal?.tenant_id).toBe(tenantId);
    expect(principal?.roles).toEqual(["enduser"]);
    expect(principal?.scopes).toEqual(["portal"]);
    expect(principal?.allowed_workflows).toEqual(["wf-a", "wf-b"]);
    expect(principal?.email).toBe("owner@pt.local");
  });

  test("a single-entry ['*'] allow-list normalizes to the literal 'all'", async () => {
    const issued = await seedToken({ allowed_workflows: ["*"] });
    const provider = createPortalTokenProvider({ db });
    const principal = await provider.resolve(bearerReq(issued.plaintext));
    expect(principal?.allowed_workflows).toBe("all");
  });

  test("the query-string token param is also accepted", async () => {
    const issued = await seedToken({});
    const provider = createPortalTokenProvider({ db });
    const req = new Request(
      `https://engine/v1/whoami?token=${encodeURIComponent(issued.plaintext)}`,
    );
    expect(await provider.resolve(req)).not.toBeNull();
  });

  test("an enduser_ref that isn't a resolvable user id still resolves, without an email", async () => {
    const issued = await seedToken({ enduser_ref: "external-crm-contact-42" });
    const provider = createPortalTokenProvider({ db });
    const principal = await provider.resolve(bearerReq(issued.plaintext));
    expect(principal).not.toBeNull();
    expect(principal?.id).toBe("external-crm-contact-42");
    expect(principal?.email).toBeUndefined();
  });
});
