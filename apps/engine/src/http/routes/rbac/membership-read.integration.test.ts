import { afterAll, beforeAll, expect, test } from "bun:test";
import { EMBEDDED_MIGRATIONS } from "../../../db/migrations/embedded.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  tenants,
  users,
} from "../../../db/schema/index.ts";
import { issueApiKey } from "../../../identity/index.ts";
import { builtinRoleId, createRole } from "../../../rbac/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let memberId: string;
let outsiderId: string;
let inheritedId: string;
let localGroupId: string;
let emptyGroupId: string;
let foreignGroupId: string;
let roleId: string;
let emptyRoleId: string;

beforeAll(async () => {
  const migration = EMBEDDED_MIGRATIONS.find((item) => item.tag.endsWith("_rbac_tenant_boundary"));
  if (!migration) throw new Error("missing RBAC boundary migration");
  server = await createHttpTestServer("membership-read", {
    testDbOptions: { upToIdx: migration.idx - 1 },
  });
  const [foreignTenant] = await server.db
    .insert(tenants)
    .values({ slug: "membership-foreign", display_name: "Foreign" })
    .returning();
  if (!foreignTenant) throw new Error("tenant seed failed");
  const role = await createRole(server.db, server.tenantId, "membership-role");
  roleId = role.id;
  emptyRoleId = (await createRole(server.db, server.tenantId, "membership-empty")).id;
  const [member, outsider, inherited] = await server.db
    .insert(users)
    .values([
      { tenant_id: server.tenantId, email: "member@membership.local", role_id: roleId },
      {
        tenant_id: foreignTenant.id,
        email: "foreign@membership.local",
        role_id: await builtinRoleId(server.db, "member"),
      },
      {
        tenant_id: server.tenantId,
        email: "inherited@membership.local",
        role_id: await builtinRoleId(server.db, "member"),
      },
    ])
    .returning();
  if (!member || !outsider || !inherited) throw new Error("user seed failed");
  memberId = member.id;
  inheritedId = inherited.id;
  outsiderId = outsider.id;
  const [local, duplicate, empty, foreign] = await server.db
    .insert(groups)
    .values([
      { tenant_id: server.tenantId, name: "Local" },
      { tenant_id: server.tenantId, name: "Duplicate" },
      { tenant_id: server.tenantId, name: "Empty" },
      { tenant_id: foreignTenant.id, name: "Foreign" },
    ])
    .returning();
  if (!local || !duplicate || !empty || !foreign) throw new Error("group seed failed");
  localGroupId = local.id;
  emptyGroupId = empty.id;
  foreignGroupId = foreign.id;
  await server.db.insert(groupMembers).values([
    { group_id: local.id, user_id: memberId },
    { group_id: duplicate.id, user_id: memberId },
    { group_id: duplicate.id, user_id: inheritedId },
    { group_id: local.id, user_id: outsiderId },
    { group_id: local.id, user_id: "10000000-0000-4000-8000-000000000099" },
    { group_id: foreign.id, user_id: memberId },
    { group_id: foreign.id, user_id: outsiderId },
  ]);
  await server.db.insert(groupRoleAssignments).values([
    { group_id: local.id, role_id: roleId },
    { group_id: duplicate.id, role_id: roleId },
    { group_id: foreign.id, role_id: emptyRoleId },
  ]);
});

afterAll(async () => {
  await server.cleanup();
});

async function read(path: string) {
  return fetch(`${server.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${server.apiKey}` },
  });
}

test("group reads count only existing tenant members, including empty groups", async () => {
  const response = await read("/v1/rbac/groups");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: { id: string; member_count: number; member_ids: string[] }[];
  };
  expect(body.items.find((group) => group.id === localGroupId)).toMatchObject({
    member_count: 1,
    member_ids: [memberId],
  });
  expect(body.items.find((group) => group.id === emptyGroupId)).toMatchObject({
    member_count: 0,
    member_ids: [],
  });
  expect(body.items.some((group) => group.id === foreignGroupId)).toBe(false);
});

test("role reads deduplicate direct and multiple inherited membership without crossing tenants", async () => {
  const response = await read("/v1/rbac/roles");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: { id: string; member_count: number; permissions: string[] }[];
  };
  expect(body.items.find((role) => role.id === roleId)).toMatchObject({
    member_count: 2,
    permissions: [],
  });
  expect(body.items.find((role) => role.id === emptyRoleId)).toMatchObject({ member_count: 0 });
  const detail = await read(`/v1/rbac/roles/${roleId}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ member_count: 2, permissions: [] });
});

test("person reads expose only that person's tenant groups and preserve foreign-user denial", async () => {
  const response = await read(`/v1/identity/users/${memberId}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { groups: { id: string; name: string }[] };
  expect(body.groups.map((group) => group.name)).toEqual(["Duplicate", "Local"]);
  expect(body.groups.some((group) => group.id === foreignGroupId)).toBe(false);
  const list = await read("/v1/identity/users");
  expect(list.status).toBe(200);
  const page = (await list.json()) as {
    items: { id: string; groups: { id: string; name: string }[] }[];
  };
  expect(page.items.find((user) => user.id === memberId)?.groups).toEqual(body.groups);
  expect(page.items.find((user) => user.id === server.userId)?.groups).toEqual([]);
  expect((await read(`/v1/identity/users/${outsiderId}`)).status).toBe(404);
});

test("identity-only credentials receive unknown group membership without RBAC disclosure", async () => {
  const issued = await issueApiKey(
    {
      issuer: { kind: "system" },
      tenant_id: server.tenantId,
      owner_kind: "user",
      owner_id: server.userId,
      actor_id: null,
      scopes: ["identity:read"],
    },
    server.db,
  );
  const headers = { authorization: `Bearer ${issued.plaintext}` };
  const response = await fetch(`${server.baseUrl}/v1/identity/users/${memberId}`, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: memberId, groups: null });
  const list = await fetch(`${server.baseUrl}/v1/identity/users`, { headers });
  expect(list.status).toBe(200);
  const body = (await list.json()) as { items: { groups: unknown }[] };
  expect(body.items.length).toBeGreaterThan(0);
  expect(body.items.every((user) => user.groups === null)).toBe(true);
  expect((await fetch(`${server.baseUrl}/v1/rbac/groups`, { headers })).status).toBe(403);
});
