import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createConnector } from "../../connectors/service.ts";
import { connectors, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";
let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("recipe-snapshot");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "recipe-snap-tenant", display_name: "rsnap" })
    .returning();
  tenant_id = t!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("connectors.template_snapshot.recipes", () => {
  test("creating a stripe connector from template snapshots all recipes", async () => {
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "Stripe",
          slug: "stripe",
          driver: "http",
          environment: "dev",
          auth_type: "bearer",
          template_slug: "stripe",
          template_source: "builtin",
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect(created.template_slug).toBe("stripe");
    const snap = created.template_snapshot as Record<string, unknown> | null;
    expect(snap).not.toBeNull();
    const recipes = (snap as { recipes?: unknown[] }).recipes;
    expect(Array.isArray(recipes)).toBe(true);
    expect((recipes as unknown[]).length).toBeGreaterThanOrEqual(12);
    for (const r of recipes as Array<Record<string, unknown>>) {
      expect(typeof r.slug).toBe("string");
      expect(r.workflow).toBeDefined();
      expect(typeof r.category).toBe("string");
      expect(Array.isArray(r.tags)).toBe(true);
      expect(["beginner", "intermediate", "advanced"]).toContain(r.difficulty as string);
      expect(typeof r.estimated_setup_minutes).toBe("number");
      expect(Array.isArray(r.prerequisites)).toBe(true);
      expect(Array.isArray(r.required_connectors)).toBe(true);
      expect(typeof r.version).toBe("string");
      expect(["subkit-builtin", "community", "tenant"]).toContain(r.author as string);
    }
    const sample = (recipes as Array<Record<string, unknown>>)[0];
    expect(sample?.category).toBe("payments");
  });

  test("template_snapshot.operator_quirks lands too — github recipe carries quirk", async () => {
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "GitHub",
          slug: "github-snap",
          driver: "http",
          environment: "dev",
          auth_type: "bearer",
          template_slug: "github",
          template_source: "builtin",
        },
        actor_id: null,
      },
      ctx.db,
    );
    const snap = created.template_snapshot as Record<string, unknown> | null;
    expect(snap).not.toBeNull();
    const quirks = (snap as { operator_quirks?: Record<string, string> }).operator_quirks ?? {};
    expect(quirks.error_handling ?? "").toMatch(/422/);
  });

  test("the connector row reflects the template snapshot independently of further reads", async () => {
    const rows = await ctx.db
      .select()
      .from(connectors)
      .where(eq(connectors.tenant_id, tenant_id))
      .orderBy(connectors.created_at);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const snap = row.template_snapshot as Record<string, unknown> | null;
      if (!snap) continue;
      expect(snap.recipes).toBeDefined();
      expect(snap.operator_quirks).toBeDefined();
    }
  });
});
