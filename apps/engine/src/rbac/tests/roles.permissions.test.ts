import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { rolePermissions, tenants } from "../../db/schema/index.ts";
import { isOperatorPermission } from "../catalog.ts";
import {
  BuiltinImmutableError,
  createRole,
  grantPermissionToRole,
  listRolePermissions,
  PermissionNotFoundError,
  RoleNotFoundError,
  revokePermissionFromRole,
} from "../roles.ts";
import { decide, MISSING_ID, seedUser, useRbacWorld, world } from "./roles-fixtures.ts";

useRbacWorld("rbac-roles-permissions");

async function holderOf(name: string, tenant_id = world.tenantA) {
  const role = await createRole(world.db, tenant_id, name);
  const user = await seedUser(tenant_id, role.id);
  return { role, user };
}

async function permissionRowCount(role_id: string): Promise<number> {
  const rows = await world.db
    .select({ role_id: rolePermissions.role_id })
    .from(rolePermissions)
    .where(eq(rolePermissions.role_id, role_id));
  return rows.length;
}

describe("grantPermissionToRole", () => {
  test("a granted permission lets the role holder pass can() through the role", async () => {
    const { role, user } = await holderOf("grant-effect");
    expect((await decide(user, world.tenantA, "audit:read")).allow).toBe(false);
    await grantPermissionToRole(world.db, world.tenantA, role.id, "audit:read");
    const decision = await decide(user, world.tenantA, "audit:read");
    expect(decision).toEqual({ allow: true, source: "role" });
    expect((await decide(user, world.tenantA, "rbac:write")).allow).toBe(false);
  });

  test("granting the same permission twice keeps a single row", async () => {
    const { role } = await holderOf("grant-twice");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "workflow:read");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "workflow:read");
    expect(await permissionRowCount(role.id)).toBe(1);
    expect(await listRolePermissions(world.db, world.tenantA, role.id)).toEqual(["workflow:read"]);
  });

  test("an unknown permission is rejected by name and writes nothing", async () => {
    const { role } = await holderOf("grant-unknown");
    const attempt = grantPermissionToRole(world.db, world.tenantA, role.id, "nope:never");
    await expect(attempt).rejects.toBeInstanceOf(PermissionNotFoundError);
    await expect(
      grantPermissionToRole(world.db, world.tenantA, role.id, "nope:never"),
    ).rejects.toThrow("permission_unknown:nope:never");
    expect(await permissionRowCount(role.id)).toBe(0);
  });

  test("a builtin role cannot gain a permission in any tenant", async () => {
    const before = await listRolePermissions(world.db, world.tenantA, world.memberRoleId);
    expect(before).not.toContain("rbac:write");
    const memberOfB = await seedUser(world.tenantB, world.memberRoleId);
    await expect(
      grantPermissionToRole(world.db, world.tenantA, world.memberRoleId, "rbac:write"),
    ).rejects.toBeInstanceOf(BuiltinImmutableError);
    expect(await listRolePermissions(world.db, world.tenantB, world.memberRoleId)).toEqual(before);
    expect((await decide(memberOfB, world.tenantB, "rbac:write")).allow).toBe(false);
  });

  test("another tenant's role cannot gain a permission", async () => {
    const { role, user } = await holderOf("grant-foreign", world.tenantB);
    await expect(
      grantPermissionToRole(world.db, world.tenantA, role.id, "audit:read"),
    ).rejects.toBeInstanceOf(RoleNotFoundError);
    expect(await permissionRowCount(role.id)).toBe(0);
    expect((await decide(user, world.tenantB, "audit:read")).allow).toBe(false);
  });

  test("an unknown role id is reported as not found", async () => {
    await expect(
      grantPermissionToRole(world.db, world.tenantA, MISSING_ID, "audit:read"),
    ).rejects.toThrow("role_not_found");
  });

  test("an operator-only permission on a tenant role stays blocked outside the operator tenant", async () => {
    const operatorPermission = "settings:write:global";
    expect(isOperatorPermission(operatorPermission)).toBe(true);
    const { role, user } = await holderOf("grant-operator");
    await grantPermissionToRole(world.db, world.tenantA, role.id, operatorPermission);
    const decision = await decide(user, world.tenantA, operatorPermission);
    expect(decision.allow).toBe(false);
    expect(decision.source).toBe("operator_boundary");
    expect(decision.reason).toBe("operator_boundary:operator_only");
  });

  test("an operator-only permission on a role of the operator tenant takes effect", async () => {
    const operatorPermission = "settings:write:global";
    await world.db.update(tenants).set({ is_operator: true }).where(eq(tenants.id, world.tenantB));
    try {
      const { role, user } = await holderOf("grant-operator-tenant", world.tenantB);
      await grantPermissionToRole(world.db, world.tenantB, role.id, operatorPermission);
      expect(await decide(user, world.tenantB, operatorPermission)).toEqual({
        allow: true,
        source: "role",
      });
    } finally {
      await world.db
        .update(tenants)
        .set({ is_operator: false })
        .where(eq(tenants.id, world.tenantB));
    }
  });
});

describe("revokePermissionFromRole", () => {
  test("a revoked permission is denied to the holder while other permissions stay", async () => {
    const { role, user } = await holderOf("revoke-effect");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "audit:read");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "workflow:read");
    expect(await revokePermissionFromRole(world.db, world.tenantA, role.id, "audit:read")).toBe(
      true,
    );
    const denied = await decide(user, world.tenantA, "audit:read");
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe("permission_denied:audit:read");
    expect((await decide(user, world.tenantA, "workflow:read")).source).toBe("role");
  });

  test("revoking a permission the role does not hold reports false", async () => {
    const { role } = await holderOf("revoke-absent");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "workflow:read");
    expect(await revokePermissionFromRole(world.db, world.tenantA, role.id, "audit:read")).toBe(
      false,
    );
    expect(await listRolePermissions(world.db, world.tenantA, role.id)).toEqual(["workflow:read"]);
  });

  test("revoking only removes the permission from the named role", async () => {
    const first = await holderOf("revoke-first");
    const second = await holderOf("revoke-second");
    await grantPermissionToRole(world.db, world.tenantA, first.role.id, "audit:read");
    await grantPermissionToRole(world.db, world.tenantA, second.role.id, "audit:read");
    await revokePermissionFromRole(world.db, world.tenantA, first.role.id, "audit:read");
    expect((await decide(second.user, world.tenantA, "audit:read")).allow).toBe(true);
    expect((await decide(first.user, world.tenantA, "audit:read")).allow).toBe(false);
  });

  test("an unknown permission is rejected by name", async () => {
    const { role } = await holderOf("revoke-unknown");
    await expect(
      revokePermissionFromRole(world.db, world.tenantA, role.id, "nope:never"),
    ).rejects.toThrow(new PermissionNotFoundError("nope:never").message);
  });

  test("a builtin role cannot lose a permission", async () => {
    const before = await listRolePermissions(world.db, world.tenantA, world.memberRoleId);
    const held = before[0];
    if (!held) throw new Error("member role holds no permission");
    await expect(
      revokePermissionFromRole(world.db, world.tenantA, world.memberRoleId, held),
    ).rejects.toBeInstanceOf(BuiltinImmutableError);
    expect(await listRolePermissions(world.db, world.tenantB, world.memberRoleId)).toEqual(before);
  });

  test("another tenant's role keeps its permission", async () => {
    const { role, user } = await holderOf("revoke-foreign", world.tenantB);
    await grantPermissionToRole(world.db, world.tenantB, role.id, "audit:read");
    await expect(
      revokePermissionFromRole(world.db, world.tenantA, role.id, "audit:read"),
    ).rejects.toBeInstanceOf(RoleNotFoundError);
    expect((await decide(user, world.tenantB, "audit:read")).allow).toBe(true);
  });

  test("an unknown role id is reported as not found", async () => {
    await expect(
      revokePermissionFromRole(world.db, world.tenantA, MISSING_ID, "audit:read"),
    ).rejects.toThrow("role_not_found");
  });
});

describe("listRolePermissions", () => {
  test("a tenant reads its own role's permissions and the builtin ones", async () => {
    const { role } = await holderOf("list-perms");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "workflow:read");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "audit:read");
    expect((await listRolePermissions(world.db, world.tenantA, role.id)).sort()).toEqual([
      "audit:read",
      "workflow:read",
    ]);
    expect(
      (await listRolePermissions(world.db, world.tenantA, world.adminRoleId)).length,
    ).toBeGreaterThan(0);
  });

  test("another tenant's role permissions are invisible", async () => {
    const { role } = await holderOf("list-perms-foreign", world.tenantB);
    await grantPermissionToRole(world.db, world.tenantB, role.id, "audit:read");
    expect(await listRolePermissions(world.db, world.tenantA, role.id)).toEqual([]);
    const rows = await world.db
      .select({ role_id: rolePermissions.role_id })
      .from(rolePermissions)
      .where(and(eq(rolePermissions.role_id, role.id)));
    expect(rows).toHaveLength(1);
  });
});
