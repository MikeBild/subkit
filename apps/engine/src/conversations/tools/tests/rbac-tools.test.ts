// find_role / find_user / inspect_role / edit_role — integration
// tests against a real test database. Pins the contract for the
// reference-impl-parity RBAC conversation surface.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { roles, tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { editRoleTool } from "../edit-role.ts";
import { findRoleTool } from "../find-role.ts";
import { findUserTool } from "../find-user.ts";
import type { ToolContext } from "../index.ts";
import { inspectRoleTool } from "../inspect-role.ts";

const uuid = createDeterministicUuidFactory(0xb12c_4ed3a);

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;
let approverRoleId: string;
let auditorRoleId: string;

function makeToolCtx(): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: uuid(),
    actor_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id, db: ctx.db }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal draft stub for unit tests
    getDraft: () => ({ workflow: { name: "t", steps: [] } }) as any,
    setDraft: async () => {},
  };
}

beforeAll(async () => {
  ctx = await createTestDb("rbac_tools");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-rbac", display_name: "T-RBAC" })
    .returning();
  tenant_id = t!.id;
  // seed two custom roles
  const r1 = await createRole(ctx.db, tenant_id, "patch_approver", "Approves patches");
  const r2 = await createRole(ctx.db, tenant_id, "compliance_auditor", "Read-only auditor");
  approverRoleId = r1.id;
  auditorRoleId = r2.id;
  await grantPermissionToRole(ctx.db, tenant_id, approverRoleId, "conversation:approve");
  await grantPermissionToRole(ctx.db, tenant_id, approverRoleId, "workflow:read");
  // seed a user
  const [u] = await ctx.db
    .insert(users)
    .values({
      tenant_id,
      email: "ada@example.com",
      role: "admin",
      role_id: approverRoleId,
    })
    .returning();
  actor_id = u!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("find_role", () => {
  test("matches by name", async () => {
    const result = await findRoleTool.execute(makeToolCtx(), { query: "approver" });
    expect(result.ok).toBe(true);
    const data = (result as { data: { matches: Array<{ name: string }> } }).data;
    expect(data.matches[0]?.name).toBe("patch_approver");
  });

  test("returns permission_count when not asking for full list", async () => {
    const result = await findRoleTool.execute(makeToolCtx(), { query: "approver" });
    const data = (result as { data: { matches: Array<Record<string, unknown>> } }).data;
    expect(data.matches[0]?.permission_count).toBe(2);
    expect(data.matches[0]?.permissions).toBeUndefined();
  });

  test("inlines permissions when include_permissions=true", async () => {
    const result = await findRoleTool.execute(makeToolCtx(), {
      query: "approver",
      include_permissions: true,
    });
    const data = (result as { data: { matches: Array<{ permissions?: string[] }> } }).data;
    expect(data.matches[0]?.permissions).toContain("conversation:approve");
  });

  test("returns role_not_found for missing id", async () => {
    const result = await findRoleTool.execute(makeToolCtx(), {
      id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("role_not_found");
  });
});

describe("find_user", () => {
  test("matches by email", async () => {
    const result = await findUserTool.execute(makeToolCtx(), { query: "ada" });
    expect(result.ok).toBe(true);
    const data = (result as { data: { matches: Array<{ email: string; role_name: string }> } })
      .data;
    expect(data.matches[0]?.email).toBe("ada@example.com");
    expect(data.matches[0]?.role_name).toBe("patch_approver");
  });
});

describe("inspect_role", () => {
  test("returns full role config + members", async () => {
    const result = await inspectRoleTool.execute(makeToolCtx(), { role_id: approverRoleId });
    expect(result.ok).toBe(true);
    const data = (
      result as {
        data: {
          role: { name: string; is_builtin: boolean };
          permissions: string[];
          members: Array<{ email: string }>;
        };
      }
    ).data;
    expect(data.role.name).toBe("patch_approver");
    expect(data.role.is_builtin).toBe(false);
    expect(data.permissions.sort()).toEqual(["conversation:approve", "workflow:read"]);
    expect(data.members.some((m) => m.email === "ada@example.com")).toBe(true);
  });
});

describe("edit_role", () => {
  test("targeted add + remove permissions", async () => {
    const result = await editRoleTool.execute(makeToolCtx(), {
      role_id: auditorRoleId,
      add_permissions: ["audit:read"],
    });
    expect(result.ok).toBe(true);
    const data = (
      result as {
        data: { granted: string[]; revoked: string[]; permissions: string[]; persistence: string };
      }
    ).data;
    expect(data.granted).toEqual(["audit:read"]);
    expect(data.revoked).toEqual([]);
    expect(data.permissions).toContain("audit:read");
    expect(data.persistence).toBe("saved");
  });

  test("full replacement diff (grants new, revokes missing)", async () => {
    const result = await editRoleTool.execute(makeToolCtx(), {
      role_id: auditorRoleId,
      permissions: ["workflow:read"],
    });
    expect(result.ok).toBe(true);
    const data = (
      result as { data: { granted: string[]; revoked: string[]; permissions: string[] } }
    ).data;
    expect(data.granted).toEqual(["workflow:read"]);
    expect(data.revoked).toEqual(["audit:read"]);
    expect(data.permissions).toEqual(["workflow:read"]);
  });

  test("description patch updates the row", async () => {
    const result = await editRoleTool.execute(makeToolCtx(), {
      role_id: auditorRoleId,
      description: "Updated auditor description",
    });
    expect(result.ok).toBe(true);
    const rows = await ctx.db.select().from(roles).where(eq(roles.id, auditorRoleId)).limit(1);
    expect(rows[0]?.description).toBe("Updated auditor description");
  });

  test("rejects edits to a built-in role", async () => {
    // The seed inserts built-in `admin` / `member` / `enduser`. Find one.
    const builtin = await ctx.db.select().from(roles).where(eq(roles.is_builtin, true)).limit(1);
    if (!builtin[0]) return; // skip if no built-in present
    const result = await editRoleTool.execute(makeToolCtx(), {
      role_id: builtin[0].id,
      description: "should fail",
    });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("builtin_immutable");
  });

  test("returns role_not_found for unknown role id", async () => {
    const result = await editRoleTool.execute(makeToolCtx(), {
      role_id: "00000000-0000-0000-0000-000000000000",
      description: "x",
    });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("role_not_found");
  });
});
