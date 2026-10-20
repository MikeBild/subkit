import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../../audit/audit.ts";
import { queryAuditLog, serializeAuditEntry } from "../../../audit/query.ts";
import type { Db } from "../../../db/client.ts";
import { apiKeys, tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../../db/tests/setup.ts";
import { generateKey } from "../../../identity/api-key.ts";
import { logger } from "../../../logging/logger.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { FROZEN_NOW } from "../../../test-helpers/determinism/clock.ts";
import { createApiKeyProvider } from "../api-key.ts";
import { resetApiKeyUsageThrottle } from "../api-key-row.ts";

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
    .values({ tenant_id: tenantId, email: "u@ak.local", role_id: await builtinRoleId(db, "admin") })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (testDb) await testDb.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

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
  test("first authenticated request records a filterable verified key use", async () => {
    const key = await seedKey({});
    resetApiKeyUsageThrottle();
    const provider = createApiKeyProvider({ db });
    expect(await provider.resolve(bearerReq(key.plaintext))).not.toBeNull();
    await _drainAuditWritesForTests(db);
    const receipts = await queryAuditLog(db, {
      tenant_id: tenantId,
      api_key_id: key.id,
      actions: ["api_key.used"],
    });
    expect(receipts.items).toHaveLength(1);
    expect(serializeAuditEntry(receipts.items[0]!).api_key_id).toBe(key.id);
  });

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
    const wrongTail = "deadbeef".repeat(4);
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
    const future = new Date(8_000_000_000_000);
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

  test("a foreign bearer token (no subkit prefix) returns null WITHOUT a malformed_token WARN", async () => {
    const warnSpy = spyOn(logger, "warn");
    try {
      const provider = createApiKeyProvider({ db });
      const foreign = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImZvbyJ9.eyJzdWIiOiJhYmMifQ.sig";
      expect(await provider.resolve(bearerReq(foreign))).toBeNull();
      const deniedWarn = warnSpy.mock.calls.find(
        (c) => (c[0] as { action?: string; reason?: string })?.reason === "malformed_token",
      );
      expect(deniedWarn).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a prefixed-but-corrupt subkit key returns null AND still WARN-logs malformed_token", async () => {
    const warnSpy = spyOn(logger, "warn");
    try {
      const provider = createApiKeyProvider({ db });
      const corrupt = "wf_live_short";
      expect(await provider.resolve(bearerReq(corrupt))).toBeNull();
      const deniedWarn = warnSpy.mock.calls.find(
        (c) => (c[0] as { action?: string; reason?: string })?.reason === "malformed_token",
      );
      expect(deniedWarn).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
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
        role_id: await builtinRoleId(db, "member"),
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
        role_id: await builtinRoleId(db, "member"),
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
