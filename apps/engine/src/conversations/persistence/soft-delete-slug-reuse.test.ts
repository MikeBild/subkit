// Regression for session abeefb33: a soft-deleted connector blocked
// re-creation under the same slug because
// `connectors_tenant_slug_env_key` was a full unique index over
// (tenant_id, slug, environment) regardless of `deleted_at`. Post-fix
// the index is partial (`WHERE deleted_at IS NULL`), so the slug
// frees up the moment the row is soft-deleted. Mirrors the same
// pattern already in place on `workflows_tenant_slug_active_key`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";

const TEST_NOW_MS = getTestNow();

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("soft_delete_slug_reuse");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-sds", display_name: "T-SDS" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenant_id = t.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("connectors · soft-delete + slug reuse", () => {
  test("can re-create a connector with the slug of a soft-deleted one", async () => {
    // Step 1: create the original.
    const [first] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "digitalocean",
        display_name: "DigitalOcean",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: "https://api.digitalocean.com/v2",
      })
      .returning();
    expect(first?.slug).toBe("digitalocean");

    // Step 2: soft-delete it (the delete_connector tool sets
    // deleted_at; we mirror that here directly).
    await ctx.db
      .update(connectors)
      .set({ deleted_at: new Date(TEST_NOW_MS) })
      .where(eq(connectors.id, first!.id));

    // Step 3: re-create with the same (tenant_id, slug, environment).
    // Pre-fix this throws 23505 unique_violation; post-fix it
    // succeeds because the partial index no longer covers the
    // soft-deleted row.
    const [second] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "digitalocean",
        display_name: "DigitalOcean (recreated)",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: "https://api.digitalocean.com/v2",
      })
      .returning();
    expect(second?.id).not.toBe(first?.id);
    expect(second?.slug).toBe("digitalocean");

    // The "live" view of the slug (deleted_at IS NULL) shows ONE row.
    const live = await ctx.db
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.tenant_id, tenant_id),
          eq(connectors.slug, "digitalocean"),
          eq(connectors.environment, "dev"),
          isNull(connectors.deleted_at),
        ),
      );
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(second!.id);
  });

  test("DOES still refuse two LIVE rows with the same (tenant, slug, env)", async () => {
    // Sanity-check: the partial unique still enforces the rule when
    // both rows are alive. Without this assertion a regression that
    // accidentally widens the partial back to "always" would slip.
    await ctx.db.insert(connectors).values({
      tenant_id,
      slug: "live-dup",
      display_name: "First Live",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    });
    let threw = false;
    try {
      await ctx.db.insert(connectors).values({
        tenant_id,
        slug: "live-dup",
        display_name: "Second Live",
        driver: "http",
        environment: "dev",
        auth_type: "none",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("different environments share a slug freely (matches workflows pattern)", async () => {
    await ctx.db.insert(connectors).values({
      tenant_id,
      slug: "env-shared",
      display_name: "Dev",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    });
    // prod env on the same slug is allowed.
    const [prod] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "env-shared",
        display_name: "Prod",
        driver: "http",
        environment: "prod",
        auth_type: "none",
      })
      .returning();
    expect(prod?.environment).toBe("prod");
  });
});
