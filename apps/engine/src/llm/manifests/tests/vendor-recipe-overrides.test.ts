// Integration test for per-tenant vendor-recipe overrides.
// Uses the testcontainer-backed db helper so the real row + index is exercised.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants, vendorRecipeOverrides } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { getVendorRecipe, getVendorRecipeForTenant } from "../vendor-recipes.ts";

let tdb: TestDb;
let tenantId: string;

beforeAll(async () => {
  tdb = await createTestDb("vendor-recipe-overrides");
  const [t] = await tdb.db
    .insert(tenants)
    .values({ slug: "vro-test", display_name: "VRO Test" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
});

afterAll(async () => {
  await tdb.cleanup();
});

describe("per-tenant vendor-recipe overrides", () => {
  test("falls back to base manifest when no override row exists", async () => {
    const r = await getVendorRecipeForTenant(tdb.db, tenantId, "codex");
    expect(r?.client).toBe("codex");
    // Matches the base manifest exactly.
    expect(r).toEqual(getVendorRecipe("codex"));
  });

  test("shallow-merges override row over the base manifest", async () => {
    await tdb.db.insert(vendorRecipeOverrides).values({
      tenant_id: tenantId,
      client: "codex",
      override: { notes: "tenant-specific override: use stdio only" },
    });
    const r = await getVendorRecipeForTenant(tdb.db, tenantId, "codex");
    expect(r?.notes).toBe("tenant-specific override: use stdio only");
    // Untouched keys preserved.
    expect(r?.transports).toEqual(getVendorRecipe("codex")!.transports);
  });

  test("returns undefined when the manifest does not ship the client (even if an override row exists)", async () => {
    await tdb.db.insert(vendorRecipeOverrides).values({
      tenant_id: tenantId,
      client: "cursor",
      override: { notes: "shouldn't appear" },
    });
    const r = await getVendorRecipeForTenant(tdb.db, tenantId, "cursor");
    expect(r).toBeUndefined();
  });

  test("normalises client lookup for override row as well", async () => {
    const r = await getVendorRecipeForTenant(tdb.db, tenantId, "CODEX");
    expect(r?.notes).toBe("tenant-specific override: use stdio only");
  });
});
