import { describe, expect, test } from "bun:test";
import { roleNameById, roleNamesById } from "../role-names.ts";
import { createRole } from "../roles.ts";
import { MISSING_ID, useRbacWorld, world } from "./roles-fixtures.ts";

useRbacWorld("rbac-role-names");

describe("roleNameById", () => {
  test("an own tenant role resolves to its name", async () => {
    const role = await createRole(world.db, world.tenantA, "names-own");
    expect(await roleNameById(world.db, world.tenantA, role.id)).toBe("names-own");
  });

  test("a builtin role resolves to its name from every tenant", async () => {
    expect(await roleNameById(world.db, world.tenantA, world.adminRoleId)).toBe("admin");
    expect(await roleNameById(world.db, world.tenantB, world.memberRoleId)).toBe("member");
  });

  test("another tenant's role resolves to null", async () => {
    const foreign = await createRole(world.db, world.tenantB, "names-foreign");
    expect(await roleNameById(world.db, world.tenantA, foreign.id)).toBeNull();
    expect(await roleNameById(world.db, world.tenantB, foreign.id)).toBe("names-foreign");
  });

  test("an unknown role id resolves to null", async () => {
    expect(await roleNameById(world.db, world.tenantA, MISSING_ID)).toBeNull();
  });
});

describe("roleNamesById", () => {
  test("the map holds builtin and own roles but no foreign role", async () => {
    const own = await createRole(world.db, world.tenantA, "map-own");
    const foreign = await createRole(world.db, world.tenantB, "map-foreign");
    const names = await roleNamesById(world.db, world.tenantA);
    expect(names.get(own.id)).toBe("map-own");
    expect(names.get(world.adminRoleId)).toBe("admin");
    expect(names.get(world.memberRoleId)).toBe("member");
    expect(names.has(foreign.id)).toBe(false);
    expect(names.has(MISSING_ID)).toBe(false);
  });

  test("each tenant's map only adds its own custom roles to the builtins", async () => {
    const a = await roleNamesById(world.db, world.tenantA);
    const b = await roleNamesById(world.db, world.tenantB);
    const builtinIds = [...a.keys()].filter((id) => b.has(id));
    for (const id of builtinIds) expect(a.get(id)).toBe(b.get(id) as string);
    expect([...a.values()]).toContain("map-own");
    expect([...b.values()]).not.toContain("map-own");
    expect([...b.values()]).toContain("map-foreign");
  });
});
