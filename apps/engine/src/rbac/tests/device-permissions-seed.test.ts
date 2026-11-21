import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { loadPermissionCatalog } from "../catalog.ts";

const DEVICE_PERMISSIONS = ["device:manage", "device:read", "device:revoke_any", "local:confirm"];

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("device-permissions-seed");
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
        AND (p.name LIKE 'device:%' OR p.name LIKE 'local:%')`,
    [role],
  );
  return result.rows.map((row: { name: string }) => row.name).sort();
}

describe("device permissions", () => {
  test("the catalog names four permissions on their two resource types", () => {
    const entries = loadPermissionCatalog().filter(
      (entry) => entry.resource_type === "device" || entry.resource_type === "local",
    );
    expect(entries.map((entry) => entry.name).sort()).toEqual(DEVICE_PERMISSIONS);
    for (const entry of entries) {
      expect(entry.name.split(":")[0]).toBe(entry.resource_type);
      expect(entry.description.trim()).not.toBe("");
      expect(entry.operator).toBeUndefined();
    }
  });

  test("an admin receives all of them, including revoking anyone's device", async () => {
    expect(await seeded("admin")).toEqual(DEVICE_PERMISSIONS);
  });

  test("a member manages own devices and confirms, but cannot revoke another person's device", async () => {
    expect(await seeded("member")).toEqual(["device:manage", "device:read", "local:confirm"]);
  });

  test("confirming comes with running workflows, devices do not", async () => {
    expect(await seeded("enduser")).toEqual(["local:confirm"]);
    for (const role of ["portal_token_user", "metrics_scraper"])
      expect(await seeded(role)).toEqual([]);
  });
});
