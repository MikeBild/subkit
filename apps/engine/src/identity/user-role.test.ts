import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../audit/index.ts";
import { auditLog, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { LastAdminError } from "./last-admin.ts";
import { assignUserRole } from "./user-role.ts";

let tdb: TestDb;
let adminRole = "";
let memberRole = "";
const ACTOR = { kind: "user" as const, id: "00000000-0000-4000-8000-0000000000a1" };

beforeAll(async () => {
  tdb = await createTestDb("user-role");
  adminRole = await builtinRoleId(tdb.db, "admin");
  memberRole = await builtinRoleId(tdb.db, "member");
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
    .values({ tenant_id, email: `${label}@example.test`, role_id: adminRole, ...overrides })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  return row.id;
}

async function roleOf(tenant_id: string, user_id: string) {
  const [row] = await tdb.db
    .select({ role_id: users.role_id })
    .from(users)
    .where(and(eq(users.tenant_id, tenant_id), eq(users.id, user_id)));
  return row?.role_id;
}

async function assignments(tenant_id: string) {
  return tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.action, AuditAction.RBAC_USER_ROLE_ASSIGNED),
      ),
    );
}

function assign(tenant_id: string, user_id: string, role: "admin" | "member") {
  return assignUserRole(tdb.db, {
    tenant_id,
    user_id,
    role_id: role === "admin" ? adminRole : memberRole,
    role_name: role,
    actor: ACTOR,
  });
}

describe("assigning a user's role", () => {
  test("demoting one of two admins succeeds and is audited", async () => {
    const tenant = await seedTenant(tdb.db);
    const first = await seedUser(tenant.id, "two-admins-a");
    await seedUser(tenant.id, "two-admins-b");

    expect(await assign(tenant.id, first, "member")).toBe(true);

    expect(await roleOf(tenant.id, first)).toBe(memberRole);
    const [event] = await assignments(tenant.id);
    expect(event?.actor_type).toBe("user");
    expect(event?.actor_id).toBe(ACTOR.id);
    expect(event?.resource_type).toBe("user");
    expect(event?.resource_id).toBe(first);
    expect(event?.result).toBe("success");
    expect(event?.metadata).toEqual({ role_id: memberRole });
  });

  test("the last admin cannot be demoted, not even by themselves", async () => {
    const tenant = await seedTenant(tdb.db);
    const only = await seedUser(tenant.id, "last-admin");
    await seedUser(tenant.id, "last-admin-member", { role_id: memberRole });

    const error = await assignUserRoleAs(tenant.id, only).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(LastAdminError);
    expect((error as LastAdminError).code).toBe("last_admin");
    expect(await roleOf(tenant.id, only)).toBe(adminRole);
    expect(await assignments(tenant.id)).toEqual([]);
  });

  test("a disabled or deleted admin does not count as a remaining admin", async () => {
    const tenant = await seedTenant(tdb.db);
    const active = await seedUser(tenant.id, "remaining-active");
    await seedUser(tenant.id, "remaining-disabled", { status: "disabled" });
    await seedUser(tenant.id, "remaining-deleted", {
      deleted_at: new Date("2023-01-01T00:00:00.000Z"),
    });

    await expect(assign(tenant.id, active, "member")).rejects.toBeInstanceOf(LastAdminError);
    expect(await roleOf(tenant.id, active)).toBe(adminRole);
  });

  test("an admin in another tenant does not keep this tenant administered", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    const only = await seedUser(tenant.id, "isolated-admin");
    await seedUser(other.id, "isolated-other-admin");

    await expect(assign(tenant.id, only, "member")).rejects.toBeInstanceOf(LastAdminError);
  });

  test("promoting a member to admin needs no remaining-admin check", async () => {
    const tenant = await seedTenant(tdb.db);
    const member = await seedUser(tenant.id, "promote-member", { role_id: memberRole });

    expect(await assign(tenant.id, member, "admin")).toBe(true);

    expect(await roleOf(tenant.id, member)).toBe(adminRole);
    expect((await assignments(tenant.id)).map((event) => event.metadata)).toEqual([
      { role_id: adminRole },
    ]);
  });

  test("re-assigning the last admin to admin keeps them admin", async () => {
    const tenant = await seedTenant(tdb.db);
    const only = await seedUser(tenant.id, "reassign-admin");

    expect(await assign(tenant.id, only, "admin")).toBe(true);
    expect(await roleOf(tenant.id, only)).toBe(adminRole);
  });

  test("changing a member's role in a tenant with one admin is allowed", async () => {
    const tenant = await seedTenant(tdb.db);
    await seedUser(tenant.id, "one-admin");
    const member = await seedUser(tenant.id, "one-admin-member", { role_id: memberRole });

    expect(await assign(tenant.id, member, "member")).toBe(true);
    expect(await assignments(tenant.id)).toHaveLength(1);
  });

  test("an unknown user answers false and writes no audit", async () => {
    const tenant = await seedTenant(tdb.db);

    expect(await assign(tenant.id, "00000000-0000-4000-8000-00000000dead", "member")).toBe(false);
    expect(await assignments(tenant.id)).toEqual([]);
  });

  test("a user of another tenant cannot be changed through this tenant", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    await seedUser(other.id, "cross-admin");
    const foreign = await seedUser(other.id, "cross-target", { role_id: memberRole });

    expect(await assign(tenant.id, foreign, "admin")).toBe(false);

    expect(await roleOf(other.id, foreign)).toBe(memberRole);
    expect(await assignments(tenant.id)).toEqual([]);
    expect(await assignments(other.id)).toEqual([]);
  });
});

function assignUserRoleAs(tenant_id: string, user_id: string) {
  return assignUserRole(tdb.db, {
    tenant_id,
    user_id,
    role_id: memberRole,
    role_name: "member",
    actor: { kind: "user", id: user_id },
  });
}
