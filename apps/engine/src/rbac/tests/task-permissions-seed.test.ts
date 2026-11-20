import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { loadPermissionCatalog } from "../catalog.ts";

const TASK_PERMISSIONS = [
  "task:delete",
  "task:grant",
  "task:pause",
  "task:read",
  "task:resume",
  "task:run",
  "task:write",
  "task_run:abort",
  "task_run:read",
];

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("task-permissions-seed");
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

async function seeded(role: string): Promise<string[]> {
  const result = await ctx.pool.query(
    `SELECT p.name FROM subkit.role_permissions rp
       JOIN subkit.roles r ON r.id = rp.role_id
       JOIN subkit.permissions p ON p.id = rp.permission_id
      WHERE r.tenant_id IS NULL AND r.is_builtin AND r.name = $1
        AND (p.name LIKE 'task:%' OR p.name LIKE 'task\\_run:%')`,
    [role],
  );
  return result.rows.map((row: { name: string }) => row.name).sort();
}

describe("task permissions", () => {
  test("the catalog names the nine permissions on their two resource types", () => {
    const entries = loadPermissionCatalog().filter(
      (entry) => entry.resource_type === "task" || entry.resource_type === "task_run",
    );
    expect(entries.map((entry) => entry.name).sort()).toEqual(TASK_PERMISSIONS);
    for (const entry of entries) {
      expect(entry.name.split(":")[0]).toBe(entry.resource_type);
      expect(entry.description.trim()).not.toBe("");
      expect(entry.operator).toBeUndefined();
    }
  });

  test("admin and member receive all of them", async () => {
    expect(await seeded("admin")).toEqual(TASK_PERMISSIONS);
    expect(await seeded("member")).toEqual(TASK_PERMISSIONS);
  });

  test("enduser, portal token user and metrics scraper receive none", async () => {
    for (const role of ["enduser", "portal_token_user", "metrics_scraper"])
      expect(await seeded(role)).toEqual([]);
  });
});
