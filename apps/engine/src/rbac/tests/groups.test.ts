import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { groupMembers, groupRoleAssignments, groups } from "../../db/schema/index.ts";
import {
  addMember,
  assignRoleToGroup,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  updateGroup,
} from "../groups.ts";
import { createRole, grantPermissionToRole } from "../roles.ts";
import { decide, MISSING_ID, seedUser, useRbacWorld, world } from "./roles-fixtures.ts";

useRbacWorld("rbac-groups-crud");

async function storedGroup(id: string) {
  const [row] = await world.db.select().from(groups).where(eq(groups.id, id));
  return row ?? null;
}

describe("createGroup", () => {
  test("a new group belongs to the calling tenant with its description", async () => {
    const group = await createGroup(world.db, world.tenantA, "editors", "edit content");
    expect(group.tenant_id).toBe(world.tenantA);
    expect(group.name).toBe("editors");
    expect(group.description).toBe("edit content");
  });

  test("a group created without description stores null", async () => {
    const group = await createGroup(world.db, world.tenantA, "plain-group");
    expect(group.description).toBeNull();
    expect((await storedGroup(group.id))?.description).toBeNull();
  });

  test("a duplicate group name in the same tenant is rejected", async () => {
    await createGroup(world.db, world.tenantA, "dup-group");
    await expect(createGroup(world.db, world.tenantA, "dup-group")).rejects.toThrow();
    const named = (await listGroups(world.db, world.tenantA)).filter((g) => g.name === "dup-group");
    expect(named).toHaveLength(1);
  });

  test("the same group name is free in another tenant and names are not case-normalised", async () => {
    const a = await createGroup(world.db, world.tenantA, "shared-group");
    const b = await createGroup(world.db, world.tenantB, "shared-group");
    const upper = await createGroup(world.db, world.tenantA, "Shared-Group");
    expect(b.id).not.toBe(a.id);
    expect(upper.id).not.toBe(a.id);
  });
});

describe("listGroups and getGroup", () => {
  test("a tenant lists only its own groups", async () => {
    const own = await createGroup(world.db, world.tenantA, "list-own-group");
    const foreign = await createGroup(world.db, world.tenantB, "list-foreign-group");
    const listed = await listGroups(world.db, world.tenantA);
    expect(listed.map((g) => g.id)).toContain(own.id);
    expect(listed.map((g) => g.id)).not.toContain(foreign.id);
    expect(listed.every((g) => g.tenant_id === world.tenantA)).toBe(true);
  });

  test("getGroup finds an own group and hides a foreign or unknown one", async () => {
    const own = await createGroup(world.db, world.tenantA, "get-own-group");
    const foreign = await createGroup(world.db, world.tenantB, "get-foreign-group");
    expect((await getGroup(world.db, world.tenantA, own.id))?.name).toBe("get-own-group");
    expect(await getGroup(world.db, world.tenantA, foreign.id)).toBeNull();
    expect(await getGroup(world.db, world.tenantA, MISSING_ID)).toBeNull();
  });
});

describe("updateGroup", () => {
  test("a rename and a description change are stored", async () => {
    const group = await createGroup(world.db, world.tenantA, "group-before", "old");
    const updated = await updateGroup(world.db, world.tenantA, group.id, {
      name: "group-after",
      description: "new",
    });
    expect(updated?.name).toBe("group-after");
    expect(updated?.description).toBe("new");
    expect((await storedGroup(group.id))?.name).toBe("group-after");
  });

  test("a partial patch keeps the untouched field", async () => {
    const group = await createGroup(world.db, world.tenantA, "group-partial", "kept");
    const renamed = await updateGroup(world.db, world.tenantA, group.id, { name: "group-renamed" });
    expect(renamed?.description).toBe("kept");
    const described = await updateGroup(world.db, world.tenantA, group.id, { description: "x" });
    expect(described?.name).toBe("group-renamed");
    expect(described?.description).toBe("x");
  });

  test("a null description clears it and an empty patch keeps everything", async () => {
    const group = await createGroup(world.db, world.tenantA, "group-clear", "soon gone");
    expect(
      (await updateGroup(world.db, world.tenantA, group.id, { description: null }))?.description,
    ).toBeNull();
    const same = await updateGroup(world.db, world.tenantA, group.id, {});
    expect(same?.name).toBe("group-clear");
    expect(same?.description).toBeNull();
  });

  test("another tenant's group answers null and stays unchanged", async () => {
    const foreign = await createGroup(world.db, world.tenantB, "group-foreign-update", "theirs");
    expect(await updateGroup(world.db, world.tenantA, foreign.id, { name: "mine" })).toBeNull();
    const stored = await storedGroup(foreign.id);
    expect(stored?.name).toBe("group-foreign-update");
    expect(stored?.description).toBe("theirs");
  });

  test("an unknown group id answers null", async () => {
    expect(await updateGroup(world.db, world.tenantA, MISSING_ID, { name: "ghost" })).toBeNull();
  });

  test("a rename onto a taken group name is rejected", async () => {
    await createGroup(world.db, world.tenantA, "group-taken");
    const group = await createGroup(world.db, world.tenantA, "group-mover");
    await expect(
      updateGroup(world.db, world.tenantA, group.id, { name: "group-taken" }),
    ).rejects.toThrow();
    expect((await storedGroup(group.id))?.name).toBe("group-mover");
  });
});

describe("deleteGroup", () => {
  test("deleting a group removes its members, role assignments and the access they gave", async () => {
    const role = await createRole(world.db, world.tenantA, "deleted-group-role");
    await grantPermissionToRole(world.db, world.tenantA, role.id, "audit:read");
    const filler = await createRole(world.db, world.tenantA, "deleted-group-filler");
    const user = await seedUser(world.tenantA, filler.id);
    const group = await createGroup(world.db, world.tenantA, "group-to-delete");
    await assignRoleToGroup(world.db, world.tenantA, group.id, role.id);
    await addMember(world.db, world.tenantA, group.id, user);
    expect((await decide(user, world.tenantA, "audit:read")).source).toBe("group");
    expect(await deleteGroup(world.db, world.tenantA, group.id)).toBe(true);
    expect(await storedGroup(group.id)).toBeNull();
    const members = await world.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.group_id, group.id));
    const assignments = await world.db
      .select()
      .from(groupRoleAssignments)
      .where(eq(groupRoleAssignments.group_id, group.id));
    expect(members).toHaveLength(0);
    expect(assignments).toHaveLength(0);
    expect((await decide(user, world.tenantA, "audit:read")).reason).toBe(
      "permission_denied:audit:read",
    );
  });

  test("deleting another tenant's group answers false and keeps it", async () => {
    const foreign = await createGroup(world.db, world.tenantB, "group-foreign-delete");
    expect(await deleteGroup(world.db, world.tenantA, foreign.id)).toBe(false);
    expect(await storedGroup(foreign.id)).not.toBeNull();
  });

  test("deleting an unknown or already deleted group answers false", async () => {
    const group = await createGroup(world.db, world.tenantA, "group-twice");
    expect(await deleteGroup(world.db, world.tenantA, group.id)).toBe(true);
    expect(await deleteGroup(world.db, world.tenantA, group.id)).toBe(false);
    expect(await deleteGroup(world.db, world.tenantA, MISSING_ID)).toBe(false);
  });
});
