// Integration tests for resolveChatPrincipal.
//
// Verifies the three invariants of the fix:
//   1. Known user returns their single enum role.
//   2. Unknown user_id → empty roles (fail-closed, no default/admin fallback).
//   3. Tenant isolation — a user_id that exists under tenant B, queried with
//      tenant A, returns empty roles.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { resolveChatPrincipal } from "./principal.ts";

const nextUuid = createDeterministicUuidFactory(0x1a2b3c4d);

let testDb: TestDb;
let tenantAId = "";
let tenantBId = "";
let userAId = "";
let userBId = "";

beforeAll(async () => {
  testDb = await createTestDb("chat-principal");

  const [tenantA] = await testDb.db
    .insert(tenants)
    .values({ slug: "chat-principal-a", display_name: "Chat Principal A" })
    .returning();
  if (!tenantA) throw new Error("seed tenant A failed");
  tenantAId = tenantA.id;

  const [tenantB] = await testDb.db
    .insert(tenants)
    .values({ slug: "chat-principal-b", display_name: "Chat Principal B" })
    .returning();
  if (!tenantB) throw new Error("seed tenant B failed");
  tenantBId = tenantB.id;

  // Tenant A has a user with role "member".
  const [userA] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenantAId,
      email: "member@tenant-a.local",
      role_id: await builtinRoleId(testDb.db, "member"),
    })
    .returning();
  if (!userA) throw new Error("seed user A failed");
  userAId = userA.id;

  // Tenant B has a different user (same role, different tenant).
  const [userB] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenantBId,
      email: "member@tenant-b.local",
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
    .returning();
  if (!userB) throw new Error("seed user B failed");
  userBId = userB.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("resolveChatPrincipal", () => {
  test("known user returns correct provider/kind/id/tenant_id/roles fields", async () => {
    const principal = await resolveChatPrincipal(testDb.db, tenantAId, userAId);
    expect(principal.provider).toBe("chat");
    expect(principal.kind).toBe("user");
    expect(principal.id).toBe(userAId);
    expect(principal.tenant_id).toBe(tenantAId);
    expect(principal.roles).toEqual(["member"]);
  });

  test("unknown user_id yields empty roles — fail-closed, no default/admin fallback", async () => {
    // Use a deterministic UUID that has no matching user row.
    const nonExistentUserId = nextUuid();
    const principal = await resolveChatPrincipal(testDb.db, tenantAId, nonExistentUserId);

    expect(principal.provider).toBe("chat");
    expect(principal.kind).toBe("user");
    expect(principal.id).toBe(nonExistentUserId);
    expect(principal.tenant_id).toBe(tenantAId);
    // CRITICAL: must be empty — no default role assigned to an unresolvable identity.
    expect(principal.roles).toEqual([]);
  });

  test("tenant isolation — user_id belonging to tenant B queried with tenant A returns empty roles", async () => {
    // userBId exists in tenant B; querying with tenant A must NOT find it.
    const principal = await resolveChatPrincipal(testDb.db, tenantAId, userBId);

    expect(principal.provider).toBe("chat");
    expect(principal.kind).toBe("user");
    expect(principal.id).toBe(userBId);
    expect(principal.tenant_id).toBe(tenantAId);
    // Cross-tenant lookup must yield empty roles — the (tenant_id, id) scope holds.
    expect(principal.roles).toEqual([]);
  });

  test("user in tenant B resolves correctly when queried with the correct tenant", async () => {
    const principal = await resolveChatPrincipal(testDb.db, tenantBId, userBId);
    expect(principal.roles).toEqual(["admin"]);
  });
});
