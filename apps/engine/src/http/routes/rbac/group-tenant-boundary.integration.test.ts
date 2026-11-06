import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { groupMembers, groupRoleAssignments, groups, users } from "../../../db/schema/index.ts";
import * as groupsSvc from "../../../rbac/groups.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let foreignTenantId: string;
let foreignUserId: string;
let localUserId: string;
let localGroupId: string;
let foreignGroupId: string;
let foreignRoleId: string;

beforeAll(async () => {
  server = await createHttpTestServer("group-tenant-boundary");
  const tenant = await seedTenant(server.db, { slug: "group-foreign", display_name: "Foreign" });
  foreignTenantId = tenant.id;
  const localEmpty = await createRole(server.db, server.tenantId, "empty");
  const foreignEmpty = await createRole(server.db, foreignTenantId, "empty");
  const grantedRole = await createRole(server.db, server.tenantId, "granted");
  await grantPermissionToRole(server.db, server.tenantId, grantedRole.id, "workflow:write");
  foreignRoleId = foreignEmpty.id;
  const [localUser, foreignUser] = await server.db
    .insert(users)
    .values([
      { tenant_id: server.tenantId, email: "local@group.test", role_id: localEmpty.id },
      { tenant_id: foreignTenantId, email: "foreign@group.test", role_id: foreignEmpty.id },
    ])
    .returning();
  const [localGroup, foreignGroup] = await server.db
    .insert(groups)
    .values([
      { tenant_id: server.tenantId, name: "Local" },
      { tenant_id: foreignTenantId, name: "Foreign" },
    ])
    .returning();
  if (!localUser || !foreignUser || !localGroup || !foreignGroup)
    throw new Error("missing group fixtures");
  localUserId = localUser.id;
  foreignUserId = foreignUser.id;
  localGroupId = localGroup.id;
  foreignGroupId = foreignGroup.id;
  await server.db.insert(groupRoleAssignments).values([
    { group_id: localGroupId, role_id: grantedRole.id },
    { group_id: foreignGroupId, role_id: foreignRoleId },
  ]);
  await server.db.insert(groupMembers).values({ group_id: foreignGroupId, user_id: foreignUserId });
});

afterAll(async () => {
  await server.cleanup();
});

async function mutate(method: string, groupId: string, suffix: string) {
  return fetch(`${server.baseUrl}/v1/rbac/groups/${groupId}/${suffix}`, {
    method,
    headers: { authorization: `Bearer ${server.apiKey}` },
  });
}

test("HTTP refuses foreign and missing users while same-tenant membership stays idempotent", async () => {
  expect((await mutate("POST", localGroupId, `members/${foreignUserId}`)).status).toBe(404);
  expect((await mutate("POST", localGroupId, `members/${server.systemAccountId}`)).status).toBe(
    404,
  );
  expect(
    (await mutate("POST", localGroupId, "members/10000000-0000-4000-8000-000000000099")).status,
  ).toBe(404);
  expect((await mutate("POST", foreignGroupId, `members/${localUserId}`)).status).toBe(404);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await mutate("POST", localGroupId, `members/${localUserId}`)).status).toBe(200);
  }
  const rows = await server.db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.group_id, localGroupId), eq(groupMembers.user_id, localUserId)));
  expect(rows).toHaveLength(1);
});

test("foreign groups cannot have memberships removed through another tenant", async () => {
  expect((await mutate("DELETE", foreignGroupId, `members/${foreignUserId}`)).status).toBe(404);
  const rows = await server.db
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.group_id, foreignGroupId));
  expect(rows).toHaveLength(1);
});

test("foreign groups cannot have roles revoked through another tenant", async () => {
  expect((await mutate("DELETE", foreignGroupId, `roles/${foreignRoleId}`)).status).toBe(404);
  const rows = await server.db
    .select()
    .from(groupRoleAssignments)
    .where(eq(groupRoleAssignments.group_id, foreignGroupId));
  expect(rows).toHaveLength(1);
});

test("domain membership and role APIs enforce tenant scope without transport prechecks", async () => {
  const db = server.db;
  expect(await groupsSvc.addMember(db, server.tenantId, localGroupId, foreignUserId)).toBe(false);
  expect(await groupsSvc.addMember(db, server.tenantId, foreignGroupId, localUserId)).toBe(false);
  expect(await groupsSvc.removeMember(db, server.tenantId, foreignGroupId, foreignUserId)).toBe(
    false,
  );
  expect(await groupsSvc.listMembers(db, server.tenantId, foreignGroupId)).toEqual([]);
  expect(await groupsSvc.listMembers(db, server.tenantId, localGroupId)).toEqual([localUserId]);
  expect(await groupsSvc.assignRoleToGroup(db, server.tenantId, localGroupId, foreignRoleId)).toBe(
    false,
  );
  expect(
    await groupsSvc.assignRoleToGroup(db, server.tenantId, foreignGroupId, foreignRoleId),
  ).toBe(false);
  expect(
    await groupsSvc.revokeRoleFromGroup(db, server.tenantId, foreignGroupId, foreignRoleId),
  ).toBe(false);
  expect(await groupsSvc.listGroupRoles(db, server.tenantId, foreignGroupId)).toEqual([]);
  const roleId = await builtinRoleId(db, "member");
  expect(await groupsSvc.assignRoleToGroup(db, server.tenantId, localGroupId, roleId)).toBe(true);
  expect(await groupsSvc.assignRoleToGroup(db, server.tenantId, localGroupId, roleId)).toBe(true);
  expect(await groupsSvc.listGroupRoles(db, server.tenantId, localGroupId)).toContain(roleId);
  expect(await groupsSvc.revokeRoleFromGroup(db, server.tenantId, localGroupId, roleId)).toBe(true);
});
