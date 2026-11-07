import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { groupMembers, groupRoleAssignments } from "../../db/schema/index.ts";
import {
  addMember,
  assignRoleToGroup,
  createGroup,
  listGroupRoles,
  listMembers,
  listTenantGroupMemberships,
  removeMember,
  revokeRoleFromGroup,
} from "../groups.ts";
import { createRole, grantPermissionToRole } from "../roles.ts";
import { decide, MISSING_ID, seedUser, useRbacWorld, world } from "./roles-fixtures.ts";

useRbacWorld("rbac-groups-membership");

let sequence = 0;

async function grantingGroup(tenant_id = world.tenantA, permission = "audit:read") {
  sequence += 1;
  const role = await createRole(world.db, tenant_id, `group-role-${sequence}`);
  await grantPermissionToRole(world.db, tenant_id, role.id, permission);
  const group = await createGroup(world.db, tenant_id, `group-${sequence}`);
  await assignRoleToGroup(world.db, tenant_id, group.id, role.id);
  return { role, group };
}

async function plainUser(tenant_id = world.tenantA): Promise<string> {
  sequence += 1;
  const role = await createRole(world.db, tenant_id, `plain-${sequence}`);
  return seedUser(tenant_id, role.id);
}

async function memberRows(group_id: string) {
  return world.db.select().from(groupMembers).where(eq(groupMembers.group_id, group_id));
}

describe("addMember", () => {
  test("a user added to a group gains the group's role permission", async () => {
    const { group } = await grantingGroup();
    const user = await plainUser();
    expect((await decide(user, world.tenantA, "audit:read")).allow).toBe(false);
    expect(await addMember(world.db, world.tenantA, group.id, user)).toBe(true);
    expect(await decide(user, world.tenantA, "audit:read")).toEqual({
      allow: true,
      source: "group",
    });
  });

  test("the adding user is recorded, and null when nobody is named", async () => {
    const { group } = await grantingGroup();
    const adder = await plainUser();
    const named = await plainUser();
    const anonymous = await plainUser();
    await addMember(world.db, world.tenantA, group.id, named, adder);
    await addMember(world.db, world.tenantA, group.id, anonymous);
    const rows = await memberRows(group.id);
    expect(rows.find((r) => r.user_id === named)?.added_by).toBe(adder);
    expect(rows.find((r) => r.user_id === anonymous)?.added_by).toBeNull();
  });

  test("adding the same user twice keeps one membership and reports true", async () => {
    const { group } = await grantingGroup();
    const user = await plainUser();
    expect(await addMember(world.db, world.tenantA, group.id, user)).toBe(true);
    expect(await addMember(world.db, world.tenantA, group.id, user)).toBe(true);
    expect(await memberRows(group.id)).toHaveLength(1);
  });

  test("a user of another tenant cannot be added and gains nothing", async () => {
    const { group } = await grantingGroup();
    const foreignUser = await plainUser(world.tenantB);
    expect(await addMember(world.db, world.tenantA, group.id, foreignUser)).toBe(false);
    expect(await memberRows(group.id)).toHaveLength(0);
    expect((await decide(foreignUser, world.tenantB, "audit:read")).allow).toBe(false);
  });

  test("another tenant's group cannot receive a member", async () => {
    const { group } = await grantingGroup(world.tenantB);
    const user = await plainUser();
    expect(await addMember(world.db, world.tenantA, group.id, user)).toBe(false);
    expect(await memberRows(group.id)).toHaveLength(0);
  });

  test("an unknown group or user answers false", async () => {
    const { group } = await grantingGroup();
    const user = await plainUser();
    expect(await addMember(world.db, world.tenantA, MISSING_ID, user)).toBe(false);
    expect(await addMember(world.db, world.tenantA, group.id, MISSING_ID)).toBe(false);
  });
});

describe("removeMember", () => {
  test("a removed member loses the group's permission", async () => {
    const { group } = await grantingGroup();
    const user = await plainUser();
    await addMember(world.db, world.tenantA, group.id, user);
    expect(await removeMember(world.db, world.tenantA, group.id, user)).toBe(true);
    const decision = await decide(user, world.tenantA, "audit:read");
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("permission_denied:audit:read");
  });

  test("removing a non-member answers false and leaves other members", async () => {
    const { group } = await grantingGroup();
    const member = await plainUser();
    const stranger = await plainUser();
    await addMember(world.db, world.tenantA, group.id, member);
    expect(await removeMember(world.db, world.tenantA, group.id, stranger)).toBe(false);
    expect(await listMembers(world.db, world.tenantA, group.id)).toEqual([member]);
  });

  test("another tenant cannot remove a member of this tenant's group", async () => {
    const { group } = await grantingGroup();
    const user = await plainUser();
    await addMember(world.db, world.tenantA, group.id, user);
    expect(await removeMember(world.db, world.tenantB, group.id, user)).toBe(false);
    expect((await decide(user, world.tenantA, "audit:read")).source).toBe("group");
  });
});

describe("listMembers", () => {
  test("a group lists exactly its members", async () => {
    const { group } = await grantingGroup();
    const first = await plainUser();
    const second = await plainUser();
    await addMember(world.db, world.tenantA, group.id, first);
    await addMember(world.db, world.tenantA, group.id, second);
    expect((await listMembers(world.db, world.tenantA, group.id)).sort()).toEqual(
      [first, second].sort(),
    );
  });

  test("another tenant's group lists nothing", async () => {
    const { group } = await grantingGroup(world.tenantB);
    await addMember(world.db, world.tenantB, group.id, await plainUser(world.tenantB));
    expect(await listMembers(world.db, world.tenantA, group.id)).toEqual([]);
    expect(await listMembers(world.db, world.tenantB, group.id)).toHaveLength(1);
  });

  test("the database refuses to plant a foreign user into a group", async () => {
    const { group } = await grantingGroup();
    const foreignUser = await plainUser(world.tenantB);
    await expect(
      (async () => {
        await world.db.insert(groupMembers).values({ group_id: group.id, user_id: foreignUser });
      })(),
    ).rejects.toMatchObject({ cause: { message: "rbac_group_member_tenant_mismatch" } });
    expect(await listMembers(world.db, world.tenantA, group.id)).toEqual([]);
  });
});

describe("assignRoleToGroup and revokeRoleFromGroup", () => {
  test("a builtin role can be assigned to a group", async () => {
    const group = await createGroup(world.db, world.tenantA, "builtin-holder");
    expect(await assignRoleToGroup(world.db, world.tenantA, group.id, world.memberRoleId)).toBe(
      true,
    );
    expect(await listGroupRoles(world.db, world.tenantA, group.id)).toEqual([world.memberRoleId]);
  });

  test("assigning the same role twice keeps one assignment", async () => {
    const { group, role } = await grantingGroup();
    expect(await assignRoleToGroup(world.db, world.tenantA, group.id, role.id)).toBe(true);
    expect(await listGroupRoles(world.db, world.tenantA, group.id)).toEqual([role.id]);
  });

  test("another tenant's role cannot be assigned to a group", async () => {
    const group = await createGroup(world.db, world.tenantA, "foreign-role-target");
    const foreign = await createRole(world.db, world.tenantB, "foreign-assignable");
    await grantPermissionToRole(world.db, world.tenantB, foreign.id, "audit:read");
    const user = await plainUser();
    await addMember(world.db, world.tenantA, group.id, user);
    expect(await assignRoleToGroup(world.db, world.tenantA, group.id, foreign.id)).toBe(false);
    const rows = await world.db
      .select()
      .from(groupRoleAssignments)
      .where(eq(groupRoleAssignments.group_id, group.id));
    expect(rows).toHaveLength(0);
    expect((await decide(user, world.tenantA, "audit:read")).allow).toBe(false);
  });

  test("a role cannot be assigned to another tenant's group or an unknown one", async () => {
    const role = await createRole(world.db, world.tenantA, "assign-elsewhere");
    const foreignGroup = await createGroup(world.db, world.tenantB, "foreign-group-target");
    expect(await assignRoleToGroup(world.db, world.tenantA, foreignGroup.id, role.id)).toBe(false);
    expect(await assignRoleToGroup(world.db, world.tenantA, MISSING_ID, role.id)).toBe(false);
    const group = await createGroup(world.db, world.tenantA, "unknown-role-target");
    expect(await assignRoleToGroup(world.db, world.tenantA, group.id, MISSING_ID)).toBe(false);
  });

  test("revoking the group's role takes the permission away from its members", async () => {
    const { group, role } = await grantingGroup();
    const user = await plainUser();
    await addMember(world.db, world.tenantA, group.id, user);
    expect(await revokeRoleFromGroup(world.db, world.tenantA, group.id, role.id)).toBe(true);
    expect((await decide(user, world.tenantA, "audit:read")).allow).toBe(false);
    expect(await revokeRoleFromGroup(world.db, world.tenantA, group.id, role.id)).toBe(false);
    expect(await listGroupRoles(world.db, world.tenantA, group.id)).toEqual([]);
  });

  test("another tenant cannot revoke a role from this tenant's group", async () => {
    const { group, role } = await grantingGroup();
    const user = await plainUser();
    await addMember(world.db, world.tenantA, group.id, user);
    expect(await revokeRoleFromGroup(world.db, world.tenantB, group.id, role.id)).toBe(false);
    expect((await decide(user, world.tenantA, "audit:read")).source).toBe("group");
  });

  test("revoking one role keeps the group's other roles", async () => {
    const { group, role } = await grantingGroup();
    await assignRoleToGroup(world.db, world.tenantA, group.id, world.memberRoleId);
    await revokeRoleFromGroup(world.db, world.tenantA, group.id, world.memberRoleId);
    expect(await listGroupRoles(world.db, world.tenantA, group.id)).toEqual([role.id]);
  });
});

describe("listGroupRoles", () => {
  test("another tenant's group lists no roles", async () => {
    const { group } = await grantingGroup(world.tenantB);
    expect(await listGroupRoles(world.db, world.tenantA, group.id)).toEqual([]);
    expect(await listGroupRoles(world.db, world.tenantB, group.id)).toHaveLength(1);
  });

  test("the database refuses to plant a foreign role into a group", async () => {
    const group = await createGroup(world.db, world.tenantA, "planted-role-group");
    const foreign = await createRole(world.db, world.tenantB, "planted-role");
    await expect(
      (async () => {
        await world.db
          .insert(groupRoleAssignments)
          .values({ group_id: group.id, role_id: foreign.id });
      })(),
    ).rejects.toThrow();
    expect(await listGroupRoles(world.db, world.tenantA, group.id)).toEqual([]);
  });
});

describe("listTenantGroupMemberships", () => {
  test("an empty user list answers empty even when memberships exist", async () => {
    const { group } = await grantingGroup();
    await addMember(world.db, world.tenantA, group.id, await plainUser());
    expect(await listTenantGroupMemberships(world.db, world.tenantA, [])).toEqual([]);
  });

  test("memberships of the named users come back with group names, ordered by group name", async () => {
    const zeta = await createGroup(world.db, world.tenantA, "zz-memberships");
    const alpha = await createGroup(world.db, world.tenantA, "aa-memberships");
    const user = await plainUser();
    const other = await plainUser();
    await addMember(world.db, world.tenantA, zeta.id, user);
    await addMember(world.db, world.tenantA, alpha.id, user);
    await addMember(world.db, world.tenantA, alpha.id, other);
    expect(await listTenantGroupMemberships(world.db, world.tenantA, [user])).toEqual([
      { group_id: alpha.id, group_name: "aa-memberships", user_id: user },
      { group_id: zeta.id, group_name: "zz-memberships", user_id: user },
    ]);
  });

  test("without a user filter all tenant memberships come back and no foreign ones", async () => {
    const own = await createGroup(world.db, world.tenantA, "all-memberships");
    const ownUser = await plainUser();
    await addMember(world.db, world.tenantA, own.id, ownUser);
    const foreign = await createGroup(world.db, world.tenantB, "foreign-memberships");
    const foreignUser = await plainUser(world.tenantB);
    await addMember(world.db, world.tenantB, foreign.id, foreignUser);
    const all = await listTenantGroupMemberships(world.db, world.tenantA);
    expect(all).toContainEqual({
      group_id: own.id,
      group_name: "all-memberships",
      user_id: ownUser,
    });
    expect(all.some((m) => m.group_id === foreign.id || m.user_id === foreignUser)).toBe(false);
    const names = all.map((m) => m.group_name);
    expect(names).toEqual([...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(await listTenantGroupMemberships(world.db, world.tenantA, [foreignUser])).toEqual([]);
  });
});
