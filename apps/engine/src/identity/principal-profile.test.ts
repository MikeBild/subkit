import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { systemAccounts, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { seedConversation, seedTenant, type TenantRow } from "../test-helpers/seed.ts";
import {
  findActiveUserProfile,
  findCockpitIdentity,
  findSystemAccountRoleName,
  findTenantSummary,
  findUserProfile,
  listRecentOwnedConversations,
  loadWhoamiProfile,
} from "./principal-profile.ts";

let tdb: TestDb;
let tenant: TenantRow;
let other: TenantRow;
let memberRole = "";
let userId = "";
let disabledId = "";
let deletedId = "";
let foreignUserId = "";
let accountId = "";
let rolelessAccountId = "";
const MISSING = "00000000-0000-4000-8000-00000000beef";

beforeAll(async () => {
  tdb = await createTestDb("principal-profile");
  tenant = await seedTenant(tdb.db, { slug: "profile-home", display_name: "Profile Home" });
  other = await seedTenant(tdb.db, { slug: "profile-other", display_name: "Profile Other" });
  memberRole = await builtinRoleId(tdb.db, "member");
  userId = await seedUser(tenant.id, "profile-user");
  disabledId = await seedUser(tenant.id, "profile-disabled", { status: "disabled" });
  deletedId = await seedUser(tenant.id, "profile-deleted", {
    deleted_at: new Date("2023-01-01T00:00:00.000Z"),
  });
  foreignUserId = await seedUser(other.id, "profile-foreign");
  accountId = await seedAccount(tenant.id, "profile-bot", memberRole);
  rolelessAccountId = await seedAccount(tenant.id, "profile-roleless", null);
});
afterAll(async () => {
  await tdb.cleanup();
});

async function seedUser(
  tenant_id: string,
  label: string,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const [row] = await tdb.db
    .insert(users)
    .values({ tenant_id, email: `${label}@example.test`, role_id: memberRole, ...overrides })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  return row.id;
}

async function seedAccount(tenant_id: string, name: string, role_id: string | null) {
  const [row] = await tdb.db
    .insert(systemAccounts)
    .values({ tenant_id, name, role_id })
    .returning({ id: systemAccounts.id });
  if (!row) throw new Error("system account fixture missing");
  return row.id;
}

function principal(
  kind: ResolvedPrincipal["kind"],
  id: string,
  tenant_id = tenant.id,
): ResolvedPrincipal {
  return { provider: "api_key", kind, id, tenant_id, roles: [] };
}

describe("reading a user profile", () => {
  test("a user profile carries the email and role name", async () => {
    expect(await findUserProfile(tdb.db, tenant.id, userId)).toEqual({
      email: "profile-user@example.test",
      role_name: "member",
    });
  });

  test("a user profile is not readable through another tenant", async () => {
    expect(await findUserProfile(tdb.db, other.id, userId)).toBeNull();
    expect(await findUserProfile(tdb.db, tenant.id, foreignUserId)).toBeNull();
  });

  test("a disabled user still has a profile but no active profile", async () => {
    expect(await findUserProfile(tdb.db, tenant.id, disabledId)).not.toBeNull();
    expect(await findActiveUserProfile(tdb.db, tenant.id, disabledId)).toBeNull();
  });

  test("a deleted user has no active profile", async () => {
    expect(await findActiveUserProfile(tdb.db, tenant.id, deletedId)).toBeNull();
  });

  test("an active user's active profile matches the profile", async () => {
    expect(await findActiveUserProfile(tdb.db, tenant.id, userId)).toEqual({
      email: "profile-user@example.test",
      role_name: "member",
    });
    expect(await findActiveUserProfile(tdb.db, other.id, userId)).toBeNull();
  });
});

describe("reading a system account role", () => {
  test("a system account reports its role name", async () => {
    expect(await findSystemAccountRoleName(tdb.db, tenant.id, accountId)).toBe("member");
  });

  test("a system account without role reports none", async () => {
    expect(await findSystemAccountRoleName(tdb.db, tenant.id, rolelessAccountId)).toBeNull();
  });

  test("a system account is not readable through another tenant", async () => {
    expect(await findSystemAccountRoleName(tdb.db, other.id, accountId)).toBeNull();
  });
});

describe("reading tenant and cockpit identity", () => {
  test("a tenant summary names the tenant", async () => {
    expect(await findTenantSummary(tdb.db, tenant.id)).toEqual({
      id: tenant.id,
      slug: "profile-home",
      display_name: "Profile Home",
      origin: "self_hosted",
    });
    expect(await findTenantSummary(tdb.db, MISSING)).toBeNull();
  });

  test("the cockpit identity joins user, role and tenant", async () => {
    expect(await findCockpitIdentity(tdb.db, tenant.id, userId)).toEqual({
      email: "profile-user@example.test",
      display_name: null,
      role_name: "member",
      auth_identity_id: null,
      start_steps_hidden_at: null,
      tenant_id: tenant.id,
      tenant_slug: "profile-home",
      tenant_display_name: "Profile Home",
      tenant_timezone: "UTC",
      tenant_language: "en",
      tenant_origin: "self_hosted",
      tenant_owner_identity_id: null,
    });
  });

  test("the cockpit identity of a user is not readable through another tenant", async () => {
    expect(await findCockpitIdentity(tdb.db, other.id, userId)).toBeNull();
  });
});

describe("listing recent owned conversations", () => {
  test("only the ten most recently updated conversations of the owner in this tenant are listed", async () => {
    const owner = await seedUser(tenant.id, "conversation-owner");
    const base = Date.UTC(2030, 0, 1);
    for (let index = 0; index < 12; index += 1) {
      await seedConversation(tdb.db, {
        tenant_id: tenant.id,
        owner_id: owner,
        title: `c-${index}`,
        updated_at: new Date(base + index * 60_000),
      });
    }
    await seedConversation(tdb.db, {
      tenant_id: tenant.id,
      owner_id: userId,
      title: "someone-else",
      updated_at: new Date(base + 99 * 60_000),
    });
    await seedConversation(tdb.db, {
      tenant_id: other.id,
      owner_id: owner,
      title: "other-tenant",
      updated_at: new Date(base + 98 * 60_000),
    });

    const rows = await listRecentOwnedConversations(tdb.db, tenant.id, owner);

    expect(rows.map((row) => row.title)).toEqual([
      "c-11",
      "c-10",
      "c-9",
      "c-8",
      "c-7",
      "c-6",
      "c-5",
      "c-4",
      "c-3",
      "c-2",
    ]);
    expect(rows.every((row) => row.tenant_id === tenant.id)).toBe(true);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.updated_at.getTime()).toBe(base + 11 * 60_000);
    expect(typeof rows[0]?.id).toBe("string");
  });
});

describe("loading the whoami profile", () => {
  test("a user sees their email, role and tenant slug", async () => {
    expect(await loadWhoamiProfile(tdb.db, principal("user", userId))).toEqual({
      email: "profile-user@example.test",
      role_name: "member",
      tenant_slug: "profile-home",
    });
  });

  test("an unknown user sees only the tenant slug", async () => {
    expect(await loadWhoamiProfile(tdb.db, principal("user", MISSING))).toEqual({
      email: null,
      role_name: null,
      tenant_slug: "profile-home",
    });
  });

  test("a system account sees its role without an email", async () => {
    expect(await loadWhoamiProfile(tdb.db, principal("system_account", accountId))).toEqual({
      email: null,
      role_name: "member",
      tenant_slug: "profile-home",
    });
  });

  test("a principal of a missing tenant has no tenant slug", async () => {
    expect(await loadWhoamiProfile(tdb.db, principal("user", userId, MISSING))).toEqual({
      email: null,
      role_name: null,
      tenant_slug: null,
    });
  });
});
