import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { roles as rolesTable, systemAccounts } from "../../db/schema/index.ts";
import {
  BuiltinImmutableError,
  createRole,
  deleteRole,
  getRole,
  listRoles,
  PermissionNotFoundError,
  RoleInUseError,
  RoleNameReservedError,
  RoleNameTakenError,
  RoleNotFoundError,
  updateRole,
} from "../roles.ts";
import { BUILTIN_ROLE_NAMES } from "../seed.ts";
import { decide, MISSING_ID, seedUser, useRbacWorld, world } from "./roles-fixtures.ts";

useRbacWorld("rbac-roles-crud");

async function storedRole(id: string) {
  const [row] = await world.db.select().from(rolesTable).where(eq(rolesTable.id, id));
  return row ?? null;
}

describe("createRole", () => {
  test("a new role belongs to the calling tenant and is never builtin", async () => {
    const role = await createRole(world.db, world.tenantA, "reviewers", "reviews drafts");
    expect(role.tenant_id).toBe(world.tenantA);
    expect(role.is_builtin).toBe(false);
    expect(role.name).toBe("reviewers");
    expect(role.description).toBe("reviews drafts");
  });

  test("a second role with the same name in one tenant is refused as taken", async () => {
    await createRole(world.db, world.tenantA, "twins");
    await expect(createRole(world.db, world.tenantA, "twins")).rejects.toBeInstanceOf(
      RoleNameTakenError,
    );
    const other = await createRole(world.db, world.tenantA, "twin-b");
    await expect(updateRole(world.db, world.tenantA, other.id, { name: "twins" })).rejects.toThrow(
      "role_name_taken:twins",
    );
    expect((await storedRole(other.id))?.name).toBe("twin-b");
    expect((await createRole(world.db, world.tenantB, "twins")).tenant_id).toBe(world.tenantB);
  });

  test("a role created without description stores null", async () => {
    const role = await createRole(world.db, world.tenantA, "no-description");
    expect(role.description).toBeNull();
    expect((await storedRole(role.id))?.description).toBeNull();
  });

  test("a second role with the same name in the same tenant is rejected", async () => {
    await createRole(world.db, world.tenantA, "dup-name");
    await expect(createRole(world.db, world.tenantA, "dup-name")).rejects.toThrow();
    const named = (await listRoles(world.db, world.tenantA)).filter((r) => r.name === "dup-name");
    expect(named).toHaveLength(1);
  });

  test("the same role name is free in another tenant", async () => {
    const a = await createRole(world.db, world.tenantA, "shared-name");
    const b = await createRole(world.db, world.tenantB, "shared-name");
    expect(b.id).not.toBe(a.id);
    expect(b.tenant_id).toBe(world.tenantB);
  });

  test("role names are not case-normalised, so names differing in case coexist", async () => {
    const lower = await createRole(world.db, world.tenantA, "ops");
    const upper = await createRole(world.db, world.tenantA, "Ops");
    expect(upper.id).not.toBe(lower.id);
    expect(upper.name).toBe("Ops");
  });

  test.each(Object.values(BUILTIN_ROLE_NAMES))(
    "a custom role cannot take the builtin name %s",
    async (name) => {
      await expect(createRole(world.db, world.tenantA, name)).rejects.toBeInstanceOf(
        RoleNameReservedError,
      );
      const shadow = (await listRoles(world.db, world.tenantA)).filter(
        (r) => r.name === name && r.tenant_id === world.tenantA,
      );
      expect(shadow).toHaveLength(0);
    },
  );

  test("a holder of a custom role cannot gain builtin admin through the role name", async () => {
    await expect(createRole(world.db, world.tenantA, "admin")).rejects.toThrow(
      "role_name_reserved:admin",
    );
    const custom = await createRole(world.db, world.tenantA, "almost-admin");
    const user = await seedUser(world.tenantA, custom.id);
    const decision = await decide(user, world.tenantA, "audit:read");
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("permission_denied:audit:read");
  });
});

describe("listRoles and getRole", () => {
  test("a tenant sees the builtin roles and its own roles but never another tenant's", async () => {
    const own = await createRole(world.db, world.tenantA, "list-own");
    const foreign = await createRole(world.db, world.tenantB, "list-foreign");
    const ids = (await listRoles(world.db, world.tenantA)).map((r) => r.id);
    expect(ids).toContain(own.id);
    expect(ids).toContain(world.adminRoleId);
    expect(ids).toContain(world.memberRoleId);
    expect(ids).not.toContain(foreign.id);
  });

  test("getRole finds an own role and a builtin role", async () => {
    const own = await createRole(world.db, world.tenantA, "get-own");
    expect((await getRole(world.db, world.tenantA, own.id))?.name).toBe("get-own");
    const builtin = await getRole(world.db, world.tenantA, world.adminRoleId);
    expect(builtin?.is_builtin).toBe(true);
    expect(builtin?.tenant_id).toBeNull();
  });

  test("getRole hides another tenant's role and an unknown id", async () => {
    const foreign = await createRole(world.db, world.tenantB, "get-foreign");
    expect(await getRole(world.db, world.tenantA, foreign.id)).toBeNull();
    expect(await getRole(world.db, world.tenantA, MISSING_ID)).toBeNull();
  });
});

describe("updateRole", () => {
  test("a rename and a new description are stored", async () => {
    const role = await createRole(world.db, world.tenantA, "before-rename", "old");
    const updated = await updateRole(world.db, world.tenantA, role.id, {
      name: "after-rename",
      description: "new",
    });
    expect(updated.name).toBe("after-rename");
    expect(updated.description).toBe("new");
    expect((await storedRole(role.id))?.name).toBe("after-rename");
  });

  test("a description-only patch keeps the name", async () => {
    const role = await createRole(world.db, world.tenantA, "keep-name", "old");
    const updated = await updateRole(world.db, world.tenantA, role.id, { description: "fresh" });
    expect(updated.name).toBe("keep-name");
    expect(updated.description).toBe("fresh");
  });

  test("a name-only patch keeps the description", async () => {
    const role = await createRole(world.db, world.tenantA, "keep-description", "kept");
    const updated = await updateRole(world.db, world.tenantA, role.id, { name: "renamed-only" });
    expect(updated.description).toBe("kept");
    expect(updated.name).toBe("renamed-only");
  });

  test("a null description clears it", async () => {
    const role = await createRole(world.db, world.tenantA, "clear-description", "gone soon");
    const updated = await updateRole(world.db, world.tenantA, role.id, { description: null });
    expect(updated.description).toBeNull();
    expect(updated.name).toBe("clear-description");
  });

  test("an empty patch changes neither name nor description", async () => {
    const role = await createRole(world.db, world.tenantA, "empty-patch", "same");
    const updated = await updateRole(world.db, world.tenantA, role.id, {});
    expect(updated.name).toBe("empty-patch");
    expect(updated.description).toBe("same");
  });

  test("a builtin role cannot be renamed", async () => {
    await expect(
      updateRole(world.db, world.tenantA, world.memberRoleId, { name: "hijacked" }),
    ).rejects.toBeInstanceOf(BuiltinImmutableError);
    expect((await storedRole(world.memberRoleId))?.name).toBe("member");
  });

  test("another tenant's role is reported as not found and stays unchanged", async () => {
    const foreign = await createRole(world.db, world.tenantB, "foreign-update", "theirs");
    await expect(
      updateRole(world.db, world.tenantA, foreign.id, { name: "taken-over" }),
    ).rejects.toBeInstanceOf(RoleNotFoundError);
    const stored = await storedRole(foreign.id);
    expect(stored?.name).toBe("foreign-update");
    expect(stored?.description).toBe("theirs");
  });

  test("an unknown role id is reported as not found", async () => {
    await expect(
      updateRole(world.db, world.tenantA, MISSING_ID, { name: "ghost" }),
    ).rejects.toThrow("role_not_found");
  });

  test("a rename onto a builtin name is rejected and the role keeps its name", async () => {
    const role = await createRole(world.db, world.tenantA, "wants-admin");
    await expect(
      updateRole(world.db, world.tenantA, role.id, { name: "admin" }),
    ).rejects.toBeInstanceOf(RoleNameReservedError);
    expect((await storedRole(role.id))?.name).toBe("wants-admin");
    const user = await seedUser(world.tenantA, role.id);
    expect((await decide(user, world.tenantA, "audit:read")).source).toBeUndefined();
  });

  test("a rename onto a name already used in the tenant is rejected", async () => {
    await createRole(world.db, world.tenantA, "occupied");
    const role = await createRole(world.db, world.tenantA, "mover");
    await expect(
      updateRole(world.db, world.tenantA, role.id, { name: "occupied" }),
    ).rejects.toThrow();
    expect((await storedRole(role.id))?.name).toBe("mover");
  });
});

describe("deleteRole", () => {
  test("an unused custom role is removed", async () => {
    const role = await createRole(world.db, world.tenantA, "to-delete");
    await deleteRole(world.db, world.tenantA, role.id);
    expect(await storedRole(role.id)).toBeNull();
    expect(await getRole(world.db, world.tenantA, role.id)).toBeNull();
  });

  test("a role still held by a user of the tenant cannot be deleted", async () => {
    const role = await createRole(world.db, world.tenantA, "held");
    await seedUser(world.tenantA, role.id);
    await expect(deleteRole(world.db, world.tenantA, role.id)).rejects.toBeInstanceOf(
      RoleInUseError,
    );
    expect(await storedRole(role.id)).not.toBeNull();
  });

  test("a role still held by a system account of the tenant cannot be deleted", async () => {
    const role = await createRole(world.db, world.tenantA, "held-by-account");
    await world.db
      .insert(systemAccounts)
      .values({ tenant_id: world.tenantA, name: "ci-bot", role_id: role.id });
    await expect(deleteRole(world.db, world.tenantA, role.id)).rejects.toBeInstanceOf(
      RoleInUseError,
    );
    expect(await storedRole(role.id)).not.toBeNull();
  });

  test("a user of another tenant does not pin a role of this tenant", async () => {
    const role = await createRole(world.db, world.tenantA, "pinned-elsewhere");
    await seedUser(world.tenantB, role.id);
    await deleteRole(world.db, world.tenantA, role.id);
    expect(await storedRole(role.id)).toBeNull();
  });

  test("a builtin role held by tenant users is refused as immutable, not as in use", async () => {
    await seedUser(world.tenantA, world.adminRoleId);
    await expect(deleteRole(world.db, world.tenantA, world.adminRoleId)).rejects.toBeInstanceOf(
      BuiltinImmutableError,
    );
    expect(await storedRole(world.adminRoleId)).not.toBeNull();
  });

  test("an unheld builtin role is refused and survives", async () => {
    await expect(deleteRole(world.db, world.tenantB, world.memberRoleId)).rejects.toThrow(
      "builtin_role_immutable",
    );
    expect(await storedRole(world.memberRoleId)).not.toBeNull();
  });

  test("another tenant's role is reported as not found and survives", async () => {
    const foreign = await createRole(world.db, world.tenantB, "foreign-delete");
    await expect(deleteRole(world.db, world.tenantA, foreign.id)).rejects.toBeInstanceOf(
      RoleNotFoundError,
    );
    expect(await storedRole(foreign.id)).not.toBeNull();
  });

  test("an unknown role id is reported as not found", async () => {
    await expect(deleteRole(world.db, world.tenantA, MISSING_ID)).rejects.toThrow("role_not_found");
  });
});

describe("role errors", () => {
  test.each([
    [new BuiltinImmutableError(), "BuiltinImmutableError", "builtin_role_immutable"],
    [new RoleNotFoundError(), "RoleNotFoundError", "role_not_found"],
    [new RoleInUseError(), "RoleInUseError", "role_in_use"],
    [new RoleNameReservedError("admin"), "RoleNameReservedError", "role_name_reserved:admin"],
    [new PermissionNotFoundError("x:y"), "PermissionNotFoundError", "permission_unknown:x:y"],
  ])("%p carries a stable name and code", (error, name, message) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.message).toBe(message);
  });
});
