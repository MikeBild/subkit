import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { SeededSkill } from "../../skills/seed.ts";
import { applySkillSeeds } from "../../skills/seed.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { skills, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const skip = testEnv.REQUIRES_PG === "0";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("skills-activates-when");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "act-when-tenant", display_name: "act-when" })
    .returning();
  tenant_id = t!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("migration 0006 — skills column shape", () => {
  test("legacy auto_load + trigger_keywords columns are gone", async () => {
    const rows = await ctx.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'skills'`,
    );
    const present = new Set(rows.rows.map((r: Record<string, unknown>) => r.column_name as string));
    expect(present.has("auto_load")).toBe(false);
    expect(present.has("trigger_keywords")).toBe(false);
    for (const expected of [
      "gates_tools",
      "activates_when",
      "input_schema",
      "output_schema",
      "side_effects",
      "idempotency",
      "maturity",
      "tags",
    ]) {
      expect(present.has(expected)).toBe(true);
    }
  });

  test("check constraints on side_effects / idempotency / maturity reject bad values", async () => {
    let threw = false;
    try {
      await Promise.resolve(
        ctx.db.execute(sql`
          INSERT INTO "skills"
            ("tenant_id", "scope", "title", "body", "lifecycle", "source", "version", "side_effects", "idempotency", "maturity")
          VALUES
            (${tenant_id}, 'global', 'Bad Side Effects', 'body', 'active', 'manual', 1, 'nuke', 'none', 'stable')
        `),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    let threw2 = false;
    try {
      await Promise.resolve(
        ctx.db.execute(sql`
          INSERT INTO "skills"
            ("tenant_id", "scope", "title", "body", "lifecycle", "source", "version", "side_effects", "idempotency", "maturity")
          VALUES
            (${tenant_id}, 'global', 'Bad Maturity', 'body', 'active', 'manual', 1, 'read', 'none', 'beta')
        `),
      );
    } catch {
      threw2 = true;
    }
    expect(threw2).toBe(true);
  });
});

describe.skipIf(skip)("seed loader → DB round trip", () => {
  test("activates_when, side_effects, idempotency, maturity, tags persist verbatim", async () => {
    const seed: SeededSkill = {
      slug: "round-trip",
      scope: "global",
      title: "Round Trip",
      description: "fixture",
      body: "body",
      gates_tools: [],
      activates_when: [
        { kind: "baseline" },
        { kind: "tool", tool: "probe_connector" },
        { kind: "intent_keyword", word: "test" },
      ],
      side_effects: "destructive",
      idempotency: "key_required",
      maturity: "experimental",
      tags: ["a", "b"],
      audience: ["driver:http", "runtime"],
      input_schema: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
      output_schema: { type: "object", properties: { y: { type: "number" } } },
      version: 7,
      body_hash: "deadbeef",
    };
    const r = await applySkillSeeds([seed], tenant_id, ctx.db);
    expect(r.inserted).toBe(1);

    const rows = await ctx.db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.slug, "round-trip")))
      .limit(1);
    const row = rows[0]!;
    expect(row.side_effects).toBe("destructive");
    expect(row.idempotency).toBe("key_required");
    expect(row.maturity).toBe("experimental");
    expect(row.tags).toEqual(["a", "b"]);
    expect(row.audience).toEqual(["driver:http", "runtime"]);
    expect(row.input_schema).toEqual({
      type: "object",
      required: ["x"],
      properties: { x: { type: "string" } },
    });
    expect(row.output_schema).toEqual({
      type: "object",
      properties: { y: { type: "number" } },
    });
    const aw = row.activates_when as Array<Record<string, unknown>>;
    expect(aw).toHaveLength(3);
    expect(aw[0]!.kind).toBe("baseline");
    expect(aw[1]!.kind).toBe("tool");
    expect(aw[2]!.kind).toBe("intent_keyword");
  });
});
