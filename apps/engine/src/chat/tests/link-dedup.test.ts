// GC6 — /subkit link token single-use semantics.
//
// `consumeLinkToken` must reject a token that has already been
// consumed. Pass 2 A3 tightens the semantics:
//
//   - The first successful consume returns the claims.
//   - Every subsequent consume (sequential *or* concurrent) throws
//     `ChatLinkAlreadyConsumedError`. This is a hard error so chat
//     adapters can distinguish "replay of a spent token" from
//     "unknown/expired token" (the latter still returns `null`).
//
// This test covers both shapes: a sequential replay, and a two-way
// concurrent race resolved through a `SELECT ... FOR UPDATE` lock
// inside a transaction.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { ChatLinkAlreadyConsumedError, consumeLinkToken, createLinkToken } from "../link.ts";

const MASTER_KEY = "00000000000000000000000000000000000000000000000000000000000000aa";

let testDb: TestDb;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  testDb = await createTestDb("chat-link-dedup");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "link-dedup", display_name: "link-dedup" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [user] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "link-dedup@test.local",
      role: "admin",
    })
    .returning();
  if (!user) throw new Error("seed user failed");
  userId = user.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("chat/link single-use dedup", () => {
  test("first consume succeeds, second consume throws AlreadyConsumed", async () => {
    const { token } = await createLinkToken(
      {
        tenant_id: tenantId,
        user_id: userId,
        platform: "slack",
        workspace_id: "T123",
        master_key: MASTER_KEY,
      },
      testDb.db,
    );

    const first = await consumeLinkToken({ token, master_key: MASTER_KEY }, testDb.db);
    expect(first).not.toBeNull();
    expect(first?.user_id).toBe(userId);
    expect(first?.platform).toBe("slack");

    let caught: unknown = null;
    try {
      await consumeLinkToken({ token, master_key: MASTER_KEY }, testDb.db);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatLinkAlreadyConsumedError);
  });

  test("two concurrent consumes: exactly one fulfilled + one AlreadyConsumed", async () => {
    const { token } = await createLinkToken(
      {
        tenant_id: tenantId,
        user_id: userId,
        platform: "slack",
        workspace_id: "T456",
        master_key: MASTER_KEY,
      },
      testDb.db,
    );

    const results = await Promise.allSettled([
      consumeLinkToken({ token, master_key: MASTER_KEY }, testDb.db),
      consumeLinkToken({ token, master_key: MASTER_KEY }, testDb.db),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof consumeLinkToken>>> =>
        r.status === "fulfilled" && r.value !== null,
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ChatLinkAlreadyConsumedError);
    expect(fulfilled[0]?.value?.workspace_id).toBe("T456");
  });
});
