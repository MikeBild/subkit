import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { connectors, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const skip = testEnv.REQUIRES_PG === "0";
let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("operator-quirks-migration");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "oq-tenant", display_name: "oq" })
    .returning();
  tenant_id = t!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("migration 0006 — connectors.operator_quirks", () => {
  test("legacy operator_notes column is GONE, operator_quirks column EXISTS", async () => {
    const res = await ctx.db.execute(
      sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'connectors'`,
    );
    const present = new Map(
      res.rows.map((r: Record<string, unknown>) => [
        r.column_name as string,
        r.data_type as string,
      ]),
    );
    expect(present.has("operator_notes")).toBe(false);
    expect(present.has("operator_quirks")).toBe(true);
    expect(present.get("operator_quirks")).toBe("jsonb");
  });

  test("operator_quirks defaults to {} on insert when not supplied", async () => {
    const [c] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "default-quirks",
        display_name: "Default Quirks",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        config: {},
        base_url: "https://example.com",
      })
      .returning();
    expect(c?.operator_quirks).toEqual({});
  });

  test("operator_quirks accepts categorized writes", async () => {
    const [c] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "rich-quirks",
        display_name: "Rich Quirks",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        config: {},
        base_url: "https://example.com",
        operator_quirks: { auth: "bearer", error_handling: "treat 422 as ok" },
      })
      .returning();
    expect(c?.operator_quirks).toEqual({ auth: "bearer", error_handling: "treat 422 as ok" });
  });

  test("template_snapshot rewrite is idempotent — running the UPDATE again is a no-op", async () => {
    await ctx.db.insert(connectors).values({
      tenant_id,
      slug: "snap-rewrite",
      display_name: "Snap Rewrite",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      config: {},
      base_url: "https://example.com",
      template_snapshot: { recipes: [], operator_quirks: {} },
    });
    const before = await ctx.db.execute(
      sql`SELECT template_snapshot FROM connectors WHERE tenant_id = ${tenant_id} AND slug = 'snap-rewrite'`,
    );
    await ctx.db.execute(sql`
      UPDATE "connectors"
      SET "template_snapshot" =
        ("template_snapshot" - 'operator_notes')
          || jsonb_build_object(
               'operator_quirks',
               COALESCE("template_snapshot" -> 'operator_quirks', '{}'::jsonb),
               'recipes',
               COALESCE("template_snapshot" -> 'recipes', '[]'::jsonb)
             )
      WHERE "template_snapshot" IS NOT NULL
        AND ("template_snapshot" ? 'operator_notes'
             OR NOT ("template_snapshot" ? 'operator_quirks')
             OR NOT ("template_snapshot" ? 'recipes'))
    `);
    const after = await ctx.db.execute(
      sql`SELECT template_snapshot FROM connectors WHERE tenant_id = ${tenant_id} AND slug = 'snap-rewrite'`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
