// `resourceAccess` is `can()` for many resources at once — and must agree with
// it on every resource, for every kind of reader. A batched evaluator that
// drifted from the per-call one would show a list item its own page refuses.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  groupMembers,
  groups,
  roles as rolesTable,
  tenants,
  users,
  workflows,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { can, resourceAccess } from "../evaluator.ts";
import { grantResource } from "../grants.ts";

let testDb: TestDb;
let tenant_id: string;
const principals: Record<string, ResolvedPrincipal> = {};
const workflowIds: string[] = [];

beforeAll(async () => {
  testDb = await createTestDb("rbac-resource-access");
  const db = testDb.db;
  const [t] = await db.insert(tenants).values({ slug: "t-ra", display_name: "RA" }).returning();
  tenant_id = t!.id;
  for (const slug of ["a", "b", "c"]) {
    const [wf] = await db
      .insert(workflows)
      .values({ tenant_id, slug, name: slug, lifecycle: "active" })
      .returning();
    workflowIds.push(wf!.id);
  }
  const [a, b] = workflowIds as [string, string];
  const roleId = async (name: string) =>
    (
      await db
        .select({ id: rolesTable.id })
        .from(rolesTable)
        .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name)))
        .limit(1)
    )[0]?.id ?? null;
  const noPermissionsRoleId = await emptyRoleId(db, tenant_id);
  const user = async (email: string, role_id: string | null) =>
    (
      await db
        .insert(users)
        .values({ tenant_id, email, role_id: role_id ?? noPermissionsRoleId })
        .returning({ id: users.id })
    )[0]!.id;

  const base = (id: string, roles: string[]): ResolvedPrincipal => ({
    provider: "api_key",
    kind: "user",
    id,
    tenant_id,
    roles,
  });
  const adminId = await user("admin@ra", await roleId("admin"));
  const memberId = await user("member@ra", await roleId("member"));
  const grantedId = await user("granted@ra", null);
  const groupedId = await user("grouped@ra", null);

  principals.admin = base(adminId, ["admin"]);
  principals.member = base(memberId, ["member"]);
  principals.granted = base(grantedId, []);
  principals.grouped = base(groupedId, []);
  principals.adminAllowlisted = { ...base(adminId, ["admin"]), allowed_workflows: [a] };
  principals.scopedOut = { ...base(grantedId, []), scopes: ["execution:read"] };
  principals.portal = {
    provider: "portal_token",
    kind: "user",
    id: grantedId,
    tenant_id,
    roles: ["portal_token_user"],
    allowed_workflows: [b],
  };

  await grantResource(db, {
    tenant_id,
    subject_type: "user",
    subject_id: grantedId,
    resource_type: "workflow",
    resource_id: a,
    permission: "workflow:read",
  });
  const [group] = await db.insert(groups).values({ tenant_id, name: "readers-b" }).returning();
  await db.insert(groupMembers).values({ group_id: group!.id, user_id: groupedId });
  await grantResource(db, {
    tenant_id,
    subject_type: "group",
    subject_id: group!.id,
    resource_type: "workflow",
    resource_id: b,
    permission: "workflow:read",
  });
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("resourceAccess agrees with can() on every resource", () => {
  for (const name of [
    "admin",
    "member",
    "granted",
    "grouped",
    "adminAllowlisted",
    "scopedOut",
    "portal",
  ]) {
    test(name, async () => {
      const principal = principals[name] as ResolvedPrincipal;
      for (const permission of ["workflow:read", "workflow:write"]) {
        const access = await resourceAccess(testDb.db, {
          tenant_id,
          principal,
          permission,
          resource_type: "workflow",
          quiet: true,
        });
        let anyAllowed = false;
        for (const id of workflowIds) {
          const single = await can(testDb.db, {
            tenant_id,
            principal,
            permission,
            resource: { type: "workflow", id },
            quiet: true,
          });
          expect({ name, permission, id, allows: access.allows(id) }).toEqual({
            name,
            permission,
            id,
            allows: single.allow,
          });
          anyAllowed ||= single.allow;
        }
        // `any` never claims a reach no resource confirms.
        if (!anyAllowed) expect(access.any).toBe(false);
      }
    });
  }
});
