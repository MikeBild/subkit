import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { EMBEDDED_MIGRATIONS } from "../../../db/migrations/embedded.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  tenants,
  users,
} from "../../../db/schema/index.ts";
import { can, resourceAccess } from "../../../rbac/evaluator.ts";
import { grantResource } from "../../../rbac/grants.ts";
import * as groupsSvc from "../../../rbac/groups.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let foreignTenantId: string;
let foreignUserId: string;
let localUserId: string;
let localGroupId: string;
let foreignPrincipal: ResolvedPrincipal;

beforeAll(async () => {
  const migration = EMBEDDED_MIGRATIONS.find((item) => item.tag.endsWith("_rbac_tenant_boundary"));
  if (!migration) throw new Error("missing RBAC boundary migration");
  server = await createHttpTestServer("group-history-boundary", {
    testDbOptions: { upToIdx: migration.idx - 1 },
  });
  const [tenant] = await server.db
    .insert(tenants)
    .values({ slug: "group-history-foreign", display_name: "Foreign" })
    .returning();
  if (!tenant) throw new Error("missing tenant fixture");
  foreignTenantId = tenant.id;
  const localEmpty = await createRole(server.db, server.tenantId, "empty");
  const foreignEmpty = await createRole(server.db, foreignTenantId, "empty");
  const grantedRole = await createRole(server.db, server.tenantId, "granted");
  await grantPermissionToRole(server.db, server.tenantId, grantedRole.id, "workflow:write");
  const [localUser, foreignUser] = await server.db
    .insert(users)
    .values([
      { tenant_id: server.tenantId, email: "local@history.test", role_id: localEmpty.id },
      { tenant_id: foreignTenantId, email: "foreign@history.test", role_id: foreignEmpty.id },
    ])
    .returning();
  const [group] = await server.db
    .insert(groups)
    .values({ tenant_id: server.tenantId, name: "Local" })
    .returning();
  if (!localUser || !foreignUser || !group) throw new Error("missing group fixtures");
  localUserId = localUser.id;
  foreignUserId = foreignUser.id;
  localGroupId = group.id;
  foreignPrincipal = {
    kind: "user",
    provider: "api_key",
    id: foreignUserId,
    tenant_id: foreignTenantId,
    roles: [],
  };
  await server.db.insert(groupMembers).values({ group_id: localGroupId, user_id: localUserId });
  await server.db
    .insert(groupRoleAssignments)
    .values({ group_id: localGroupId, role_id: grantedRole.id });
});

afterAll(async () => {
  await server.cleanup();
});

test("historical cross-tenant membership never grants permissions", async () => {
  await server.db
    .insert(groupMembers)
    .values({ group_id: localGroupId, user_id: foreignUserId })
    .onConflictDoNothing();
  const decision = await can(server.db, {
    tenant_id: foreignTenantId,
    principal: foreignPrincipal,
    permission: "workflow:write",
    quiet: true,
  });
  expect(decision.allow).toBe(false);
});

test("historical cross-tenant groups never supply resource grants in can or resourceAccess", async () => {
  const resourceId = "10000000-0000-4000-8000-000000000077";
  await grantResource(server.db, {
    tenant_id: foreignTenantId,
    subject_type: "group",
    subject_id: localGroupId,
    resource_type: "workflow",
    resource_id: resourceId,
    permission: "workflow:read",
  });
  expect(
    (
      await can(server.db, {
        tenant_id: foreignTenantId,
        principal: foreignPrincipal,
        permission: "workflow:read",
        resource: { type: "workflow", id: resourceId },
        quiet: true,
      })
    ).allow,
  ).toBe(false);
  const access = await resourceAccess(server.db, {
    tenant_id: foreignTenantId,
    principal: foreignPrincipal,
    permission: "workflow:read",
    resource_type: "workflow",
    quiet: true,
  });
  expect(access.any).toBe(false);
  expect(access.allows(resourceId)).toBe(false);
});

test("historical foreign custom role assignment never grants a local group permission", async () => {
  const role = await createRole(server.db, foreignTenantId, "foreign-granted");
  await grantPermissionToRole(server.db, foreignTenantId, role.id, "audit:read");
  await server.db.insert(groupRoleAssignments).values({ group_id: localGroupId, role_id: role.id });
  const decision = await can(server.db, {
    tenant_id: server.tenantId,
    principal: {
      kind: "user",
      provider: "api_key",
      id: localUserId,
      tenant_id: server.tenantId,
      roles: [],
    },
    permission: "audit:read",
    quiet: true,
  });
  expect(decision.allow).toBe(false);
  expect(await groupsSvc.listGroupRoles(server.db, server.tenantId, localGroupId)).not.toContain(
    role.id,
  );
});
