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

    await ctx.db
      .update(connectors)
      .set({ deleted_at: new Date(TEST_NOW_MS) })
      .where(eq(connectors.id, first!.id));

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
