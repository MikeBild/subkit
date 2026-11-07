import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { roles as rolesTable } from "../../db/schema/index.ts";
import { addMember, assignRoleToGroup, createGroup } from "../groups.ts";
import {
  builtinRoleId,
  createRole,
  grantPermissionToRole,
  listRolePermissions,
  RoleNotFoundError,
  roleMemberCounts,
  tenantRolePermissions,
} from "../roles.ts";
import { seedUser, useRbacWorld, world } from "./roles-fixtures.ts";

useRbacWorld("rbac-roles-queries");

describe("builtinRoleId", () => {
  test("each seeded builtin name resolves to its global builtin row", async () => {
    for (const name of ["admin", "member", "enduser"]) {
      const id = await builtinRoleId(world.db, name);
      const [row] = await world.db.select().from(rolesTable).where(eq(rolesTable.id, id));
      expect(row?.name).toBe(name);
      expect(row?.tenant_id).toBeNull();
      expect(row?.is_builtin).toBe(true);
    }
  });

  test("a tenant role is never returned as a builtin", async () => {
    await createRole(world.db, world.tenantA, "tenant-only");
    await expect(builtinRoleId(world.db, "tenant-only")).rejects.toBeInstanceOf(RoleNotFoundError);
  });

  test("an unknown name is reported as not found", async () => {
    await expect(builtinRoleId(world.db, "no-such-role")).rejects.toThrow("role_not_found");
  });

  test("the builtin lookup is case sensitive", async () => {
    const [global] = await world.db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, "ADMIN")));
    expect(global).toBeUndefined();
    await expect(builtinRoleId(world.db, "ADMIN")).rejects.toThrow("role_not_found");
  });
});

describe("roleMemberCounts", () => {
  test("a role without holders counts zero", async () => {
    const role = await createRole(world.db, world.tenantA, "count-empty");
    expect((await roleMemberCounts(world.db, world.tenantA)).get(role.id)).toBe(0);
  });

  test("direct holders and group members are counted, a user holding both only once", async () => {
    const role = await createRole(world.db, world.tenantA, "count-mixed");
    const filler = await createRole(world.db, world.tenantA, "count-filler");
    const direct = await seedUser(world.tenantA, role.id);
    const viaGroup = await seedUser(world.tenantA, filler.id);
    const group = await createGroup(world.db, world.tenantA, "count-group");
    await assignRoleToGroup(world.db, world.tenantA, group.id, role.id);
    await addMember(world.db, world.tenantA, group.id, viaGroup);
    await addMember(world.db, world.tenantA, group.id, direct);
    const counts = await roleMemberCounts(world.db, world.tenantA);
    expect(counts.get(role.id)).toBe(2);
    expect(counts.get(filler.id)).toBe(1);
  });

  test("a group member counts for a role assigned to another group only when in that group", async () => {
    const role = await createRole(world.db, world.tenantA, "count-other-group");
    const filler = await createRole(world.db, world.tenantA, "count-other-filler");
    const outsider = await seedUser(world.tenantA, filler.id);
    const withRole = await createGroup(world.db, world.tenantA, "count-with-role");
    const withoutRole = await createGroup(world.db, world.tenantA, "count-without-role");
    await assignRoleToGroup(world.db, world.tenantA, withRole.id, role.id);
    await addMember(world.db, world.tenantA, withoutRole.id, outsider);
    expect((await roleMemberCounts(world.db, world.tenantA)).get(role.id)).toBe(0);
  });

  test("builtin role counts only include holders of the calling tenant", async () => {
    const before = (await roleMemberCounts(world.db, world.tenantB)).get(world.memberRoleId) ?? 0;
    await seedUser(world.tenantA, world.memberRoleId);
    const afterB = (await roleMemberCounts(world.db, world.tenantB)).get(world.memberRoleId);
    expect(afterB).toBe(before);
    await seedUser(world.tenantB, world.memberRoleId);
    expect((await roleMemberCounts(world.db, world.tenantB)).get(world.memberRoleId)).toBe(
      before + 1,
    );
  });

  test("another tenant's roles are absent from the counts", async () => {
    const foreign = await createRole(world.db, world.tenantB, "count-foreign");
    await seedUser(world.tenantB, foreign.id);
    const counts = await roleMemberCounts(world.db, world.tenantA);
    expect(counts.has(foreign.id)).toBe(false);
    expect(counts.has(world.adminRoleId)).toBe(true);
    expect((await roleMemberCounts(world.db, world.tenantB)).get(foreign.id)).toBe(1);
  });
});

describe("tenantRolePermissions", () => {
  test("a role's permissions are listed in name order", async () => {
    const role = await createRole(world.db, world.tenantA, "perm-order");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "workflow:read");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "audit:read");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "connector:read");
    const map = await tenantRolePermissions(world.db, world.tenantA);
    expect(map.get(role.id)).toEqual(["audit:read", "connector:read", "workflow:read"]);
  });

  test("builtin roles appear with their full permission set", async () => {
    const map = await tenantRolePermissions(world.db, world.tenantA);
    const expected = (
      await listRolePermissions(world.db, world.tenantA, world.memberRoleId)
    ).sort();
    expect([...(map.get(world.memberRoleId) ?? [])].sort()).toEqual(expected);
  });

  test("a role without permissions and another tenant's roles are absent", async () => {
    const empty = await createRole(world.db, world.tenantA, "perm-empty");
    const foreign = await createRole(world.db, world.tenantB, "perm-foreign");
    await grantPermissionToRole(world.db, world.tenantB, foreign.id, "audit:read");
    const map = await tenantRolePermissions(world.db, world.tenantA);
    expect(map.has(empty.id)).toBe(false);
    expect(map.has(foreign.id)).toBe(false);
    expect((await tenantRolePermissions(world.db, world.tenantB)).get(foreign.id)).toEqual([
      "audit:read",
    ]);
  });
});
