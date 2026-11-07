import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { systemAccounts, users } from "../../db/schema/index.ts";
import {
  findRoleNameByRoleId,
  findSystemAccountRoleId,
  findUserRoleName,
  listRoleMembers,
  listRoleNamesByRoleIds,
} from "../actor-roles.ts";
import {
  addSystemAccount,
  addTenant,
  addUser,
  builtinRole,
  customRole,
  useAccessDb,
} from "./workflow-start-access-fixtures.ts";

const h = useAccessDb("actor_roles", 20_261_108);

let tenantA: string;
let tenantB: string;
let memberRole: string;
let reviewerA: string;
let memberA1: string;
let memberA2: string;
let reviewerUserA: string;
let memberB: string;
let botA: string;
let roleLessBotA: string;

beforeAll(async () => {
  tenantA = await addTenant(h, "ar-a");
  tenantB = await addTenant(h, "ar-b");
  memberRole = await builtinRole(h, "member");
  reviewerA = await customRole(h, tenantA, "reviewer", ["workflow:read"]);
  memberA1 = await addUser(h, tenantA, "m1@ar", memberRole);
  memberA2 = await addUser(h, tenantA, "m2@ar", memberRole);
  reviewerUserA = await addUser(h, tenantA, "reviewer@ar", reviewerA);
  memberB = await addUser(h, tenantB, "m@ar-b", memberRole);
  botA = await addSystemAccount(h, tenantA, "bot", reviewerA);
  roleLessBotA = await addSystemAccount(h, tenantA, "roleless", null);
});

describe("findUserRoleName", () => {
  test("a user resolves to its builtin or custom role name", async () => {
    expect(await findUserRoleName(h.db, tenantA, memberA1)).toEqual({ role_name: "member" });
    expect(await findUserRoleName(h.db, tenantA, reviewerUserA)).toEqual({ role_name: "reviewer" });
  });

  test("a user of another tenant or an unknown id resolves to nothing", async () => {
    expect(await findUserRoleName(h.db, tenantB, memberA1)).toBeUndefined();
    expect(await findUserRoleName(h.db, tenantA, memberB)).toBeUndefined();
    expect(await findUserRoleName(h.db, tenantA, h.nextId())).toBeUndefined();
  });

  test("a deleted user resolves to nothing", async () => {
    const gone = await addUser(h, tenantA, "gone@ar", memberRole);
    await h.db
      .update(users)
      .set({ deleted_at: new Date(0) })
      .where(eq(users.id, gone));
    expect(await findUserRoleName(h.db, tenantA, gone)).toBeUndefined();
  });

  test("a system account id is not resolved as a user", async () => {
    expect(await findUserRoleName(h.db, tenantA, botA)).toBeUndefined();
  });
});

describe("findSystemAccountRoleId", () => {
  test("a system account returns its role id, or null when it has none", async () => {
    expect(await findSystemAccountRoleId(h.db, tenantA, botA)).toEqual({ role_id: reviewerA });
    expect(await findSystemAccountRoleId(h.db, tenantA, roleLessBotA)).toEqual({ role_id: null });
  });

  test("a deleted system account resolves to nothing", async () => {
    const gone = await addSystemAccount(h, tenantA, "gone-bot", reviewerA);
    await h.db
      .update(systemAccounts)
      .set({ deleted_at: new Date(0) })
      .where(eq(systemAccounts.id, gone));
    expect(await findSystemAccountRoleId(h.db, tenantA, gone)).toBeUndefined();
  });

  test("a system account of another tenant or a user id resolves to nothing", async () => {
    expect(await findSystemAccountRoleId(h.db, tenantB, botA)).toBeUndefined();
    expect(await findSystemAccountRoleId(h.db, tenantA, memberA1)).toBeUndefined();
  });
});

describe("role name lookups", () => {
  test("a global and a tenant role both resolve by id", async () => {
    expect(await findRoleNameByRoleId(h.db, memberRole)).toBe("member");
    expect(await findRoleNameByRoleId(h.db, reviewerA)).toBe("reviewer");
  });

  test("an unknown role id resolves to nothing", async () => {
    expect(await findRoleNameByRoleId(h.db, h.nextId())).toBeUndefined();
  });

  test("a batch lookup returns only the known ids with their names", async () => {
    const rows = await listRoleNamesByRoleIds(h.db, [reviewerA, memberRole, h.nextId()]);
    expect(rows.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { id: memberRole, name: "member" },
      { id: reviewerA, name: "reviewer" },
    ]);
  });

  test("an empty batch returns an empty list", async () => {
    expect(await listRoleNamesByRoleIds(h.db, [])).toEqual([]);
  });
});

describe("listRoleMembers", () => {
  test("a deleted user is no longer listed as a member of its role", async () => {
    const left = await addUser(h, tenantA, "left@ar", reviewerA);
    await h.db
      .update(users)
      .set({ deleted_at: new Date(0) })
      .where(eq(users.id, left));
    const rows = await listRoleMembers(h.db, tenantA, reviewerA);
    expect(rows).toEqual([{ id: reviewerUserA, email: "reviewer@ar" }]);
  });

  test("a shared builtin role lists only the members of the asking tenant", async () => {
    const rows = await listRoleMembers(h.db, tenantA, memberRole);
    expect(rows.sort((a, b) => a.email.localeCompare(b.email))).toEqual([
      { id: memberA1, email: "m1@ar" },
      { id: memberA2, email: "m2@ar" },
    ]);
    expect(await listRoleMembers(h.db, tenantB, memberRole)).toEqual([
      { id: memberB, email: "m@ar-b" },
    ]);
  });

  test("a tenant role lists nothing for another tenant", async () => {
    expect(await listRoleMembers(h.db, tenantA, reviewerA)).toEqual([
      { id: reviewerUserA, email: "reviewer@ar" },
    ]);
    expect(await listRoleMembers(h.db, tenantB, reviewerA)).toEqual([]);
  });
});
