// api-key auth provider — negative-path tests.
//
// The api-key provider has six rejection paths in resolve():
// malformed token, prefix not found,
// hash mismatch, revoked, not_before in the future, expired. The
// existing http/tests/auth.test.ts covers malformed + missing cases
// at the route layer; this file pins the provider-direct behavior for
// the four time/state-bound rejections and the happy path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { apiKeys, tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { generateKey } from "../../../identity/api-key.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { createApiKeyProvider } from "../api-key.ts";

let testDb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  testDb = await createTestDb("api_key_negative");
  db = testDb.db;
  const [t] = await db
    .insert(tenants)
    .values({ slug: "ak-neg", display_name: "API Key Negative" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
  const [u] = await db
    .insert(users)
    .values({ tenant_id: tenantId, email: "u@ak.local", role: "admin" })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

async function seedKey(overrides: {
  revoked_at?: Date;
  not_before?: Date;
  expires_at?: Date;
}): Promise<{ plaintext: string; id: string }> {
  const key = generateKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["*"],
      ...(overrides.revoked_at !== undefined ? { revoked_at: overrides.revoked_at } : {}),
      ...(overrides.not_before !== undefined ? { not_before: overrides.not_before } : {}),
      ...(overrides.expires_at !== undefined ? { expires_at: overrides.expires_at } : {}),
    })
    .returning();
  if (!row) throw new Error("seed api key failed");
  return { plaintext: key.plaintext, id: row.id };
}

function bearerReq(token: string): Request {
  return new Request("https://engine/v1/whoami", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("api-key provider — negative paths", () => {
  test("malformed token (wrong prefix) returns null without DB hit", async () => {
    const provider = createApiKeyProvider({ db });
    const req = bearerReq("not_a_subkit_key");
    expect(await provider.resolve(req)).toBeNull();
  });

  test("prefix not found returns null", async () => {
    const provider = createApiKeyProvider({ db });
    const fake = "wf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const req = bearerReq(fake);
    expect(await provider.resolve(req)).toBeNull();
  });

  test("hash mismatch (right prefix, wrong tail) returns null", async () => {
    const issued = await seedKey({});
    const wrongTail = "deadbeef".repeat(4); // 32 chars
    const wrongToken = `${issued.plaintext.slice(0, 12)}${wrongTail}`;
    const provider = createApiKeyProvider({ db });
    const principal = await provider.resolve(bearerReq(wrongToken));
    expect(principal).toBeNull();
  });

  test("revoked api key returns null", async () => {
    const past = new Date(FROZEN_NOW - 60_000);
    const issued = await seedKey({ revoked_at: past });
    const provider = createApiKeyProvider({ db });
    expect(await provider.resolve(bearerReq(issued.plaintext))).toBeNull();
  });

  test("not_yet_active (not_before in the future) returns null", async () => {
    // Stable far-future date so the comparison is deterministic.
    const future = new Date(8_000_000_000_000); // year 2223
    const issued = await seedKey({ not_before: future });
    const provider = createApiKeyProvider({ db });
    expect(await provider.resolve(bearerReq(issued.plaintext))).toBeNull();
  });

  test("expired api key returns null", async () => {
    const past = new Date(FROZEN_NOW - 60_000);
    const issued = await seedKey({ expires_at: past });
    const provider = createApiKeyProvider({ db });
    expect(await provider.resolve(bearerReq(issued.plaintext))).toBeNull();
  });

  test("happy-path key resolves with correct tenant + principal id", async () => {
    const issued = await seedKey({});
    const provider = createApiKeyProvider({ db });
    const principal = await provider.resolve(bearerReq(issued.plaintext));
    expect(principal).not.toBeNull();
    expect(principal?.id).toBe(userId);
    expect(principal?.tenant_id).toBe(tenantId);
  });

  test("query-string token is also accepted", async () => {
    const issued = await seedKey({});
    const provider = createApiKeyProvider({ db });
    const req = new Request(
      `https://engine/v1/whoami?token=${encodeURIComponent(issued.plaintext)}`,
    );
    expect(await provider.resolve(req)).not.toBeNull();
  });

  test("missing both header and query token returns null without parse", async () => {
    const provider = createApiKeyProvider({ db });
    const req = new Request("https://engine/v1/whoami");
    expect(await provider.resolve(req)).toBeNull();
  });
});

async function seedKeyForUser(uid: string): Promise<string> {
  const key = generateKey();
  await db.insert(apiKeys).values({
    tenant_id: tenantId,
    user_id: uid,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });
  return key.plaintext;
}

describe("api-key provider — user lifecycle", () => {
  test("a disabled user's key returns null", async () => {
    const [u] = await db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "disabled@ak.local",
        role: "member",
        status: "disabled",
      })
      .returning();
    const token = await seedKeyForUser(u!.id);
    const provider = createApiKeyProvider({ db });
    expect(await provider.resolve(bearerReq(token))).toBeNull();
  });

  test("a soft-deleted user's key returns null", async () => {
    const [u] = await db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "deleted@ak.local",
        role: "member",
        deleted_at: new Date(FROZEN_NOW - 60_000),
      })
      .returning();
    const token = await seedKeyForUser(u!.id);
    const provider = createApiKeyProvider({ db });
    expect(await provider.resolve(bearerReq(token))).toBeNull();
  });
});

describe("api-key provider — tenant boundary", () => {
  test("the persisted row's tenant_id matches the resolved principal's tenant_id", async () => {
    const issued = await seedKey({});
    const provider = createApiKeyProvider({ db });
    const principal = await provider.resolve(bearerReq(issued.plaintext));
    expect(principal?.tenant_id).toBe(tenantId);
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, issued.id));
    expect(rows[0]?.tenant_id).toBe(tenantId);
  });
});
