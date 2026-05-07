// Skill-seed loader tests.
//
// Coverage:
//   - frontmatter parsing: happy path, missing keys, bad scope, bad yaml
//   - content-hash drift detection: second apply of unchanged seed is a no-op
//   - apply creates row with correct shape
//   - apply updates body + gates_tools + bumps version when hash differs
//   - per-tenant isolation: two tenants each get their own row
//
// After the #149 refactor the loader no longer reads from disk — every
// test feeds synthetic seed content via `loadSkillSeedsFromContent`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { skills, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  applySkillSeeds,
  applySkillSeedsForAllTenants,
  loadEmbeddedSkillSeeds,
  loadSkillSeedsFromContent,
  type SeedSource,
} from "../seed.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  ctx = await createTestDb("skills_seed");
  const [a] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-seed-a", display_name: "A" })
    .returning();
  const [b] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-seed-b", display_name: "B" })
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function validSeedMd(opts: {
  slug: string;
  title?: string;
  description?: string;
  gates?: string[];
  body?: string;
  scope?: string;
}): string {
  const gatesLine =
    opts.gates && opts.gates.length > 0
      ? `gates_tools: [${opts.gates.join(", ")}]`
      : "gates_tools: []";
  return [
    "---",
    `slug: ${opts.slug}`,
    `scope: ${opts.scope ?? "global"}`,
    `title: ${opts.title ?? "Generated"}`,
    `description: ${opts.description ?? "One-line hook."}`,
    gatesLine,
    "version: 1",
    "---",
    "",
    opts.body ?? "# Body\n\nSomething useful here.",
  ].join("\n");
}

function source(name: string, content: string): SeedSource {
  return { file: `${name}.md`, content };
}

describe("loadSkillSeedsFromContent — happy path", () => {
  test("parses every supplied entry, frontmatter intact", () => {
    const r = loadSkillSeedsFromContent([
      source("a", validSeedMd({ slug: "a", title: "A title" })),
      source("b", validSeedMd({ slug: "b", gates: ["tool_x"], body: "# B\n\n- item" })),
    ]);
    expect(r.errors).toEqual([]);
    expect(r.skills).toHaveLength(2);
    const a = r.skills.find((s) => s.slug === "a")!;
    expect(a.title).toBe("A title");
    expect(a.gates_tools).toEqual([]);
    const b = r.skills.find((s) => s.slug === "b")!;
    expect(b.gates_tools).toEqual(["tool_x"]);
    expect(b.body).toContain("- item");
    expect(b.body_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("empty input returns empty result", () => {
    const r = loadSkillSeedsFromContent([]);
    expect(r.skills).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.embedded_count).toBe(0);
  });
});

describe("loadSkillSeedsFromContent — error paths", () => {
  test("missing frontmatter reports missing_frontmatter", () => {
    const r = loadSkillSeedsFromContent([source("x", "no frontmatter here")]);
    expect(r.skills).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("missing_frontmatter");
  });

  test("missing required key reports missing_key", () => {
    const r = loadSkillSeedsFromContent([source("nope", "---\nslug: x\n---\nbody")]);
    expect(r.errors[0]!.code).toBe("missing_key");
  });

  test("bad scope reports bad_scope", () => {
    const r = loadSkillSeedsFromContent([
      source(
        "weird",
        [
          "---",
          "slug: w",
          "scope: universe",
          "title: T",
          "description: D",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("bad_scope");
  });

  test("malformed yaml line reports bad_yaml", () => {
    const r = loadSkillSeedsFromContent([
      source(
        "y",
        [
          "---",
          "slug: y",
          "NoColonHere",
          "scope: global",
          "title: T",
          "description: D",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("bad_yaml");
  });
});

describe("applySkillSeeds — DB upsert semantics", () => {
  test("inserts rows on first apply, unchanged on second", async () => {
    const loaded = loadSkillSeedsFromContent([
      source("alpha", validSeedMd({ slug: "alpha" })),
      source("beta", validSeedMd({ slug: "beta", gates: ["tool_b"] })),
    ]);
    expect(loaded.errors).toEqual([]);

    const first = await applySkillSeeds(loaded.skills, tenantA, ctx.db);
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);

    const second = await applySkillSeeds(loaded.skills, tenantA, ctx.db);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(2);

    const rows = await ctx.db.select().from(skills).where(eq(skills.tenant_id, tenantA));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.slug).not.toBeNull();
      expect(row.seed_source).not.toBeNull();
      expect(Array.isArray(row.gates_tools)).toBe(true);
    }
    const betaRow = rows.find((r) => r.slug === "beta")!;
    expect(betaRow.gates_tools).toEqual(["tool_b"]);
  });

  test("body change → UPDATE + version bump", async () => {
    const v1 = loadSkillSeedsFromContent([
      source(
        "evolve",
        validSeedMd({
          slug: "evolve",
          body: "# Evolve v1\n\nInitial body.",
        }),
      ),
    ]);
    const a1 = await applySkillSeeds(v1.skills, tenantB, ctx.db);
    expect(a1.inserted).toBeGreaterThan(0);
    const row1 = await oneByTenantSlug(ctx, tenantB, "evolve");
    expect(row1.version).toBe(1);

    const v2 = loadSkillSeedsFromContent([
      source(
        "evolve",
        validSeedMd({
          slug: "evolve",
          body: "# Evolve v2\n\nNew body with more detail.",
        }),
      ),
    ]);
    const a2 = await applySkillSeeds(v2.skills, tenantB, ctx.db);
    expect(a2.updated).toBe(1);
    expect(a2.inserted).toBe(0);
    expect(a2.unchanged).toBe(0);
    const row2 = await oneByTenantSlug(ctx, tenantB, "evolve");
    expect(row2.body).toContain("v2");
    expect(row2.version).toBeGreaterThan(1);
    expect(row2.seed_source).not.toBe(row1.seed_source);
  });

  test("gates_tools change alone triggers UPDATE", async () => {
    const l1 = loadSkillSeedsFromContent([
      source("gatechange", validSeedMd({ slug: "gatechange", gates: [] })),
    ]);
    await applySkillSeeds(l1.skills, tenantA, ctx.db);

    const l2 = loadSkillSeedsFromContent([
      source("gatechange", validSeedMd({ slug: "gatechange", gates: ["g_a", "g_b"] })),
    ]);
    const r = await applySkillSeeds(l2.skills, tenantA, ctx.db);
    expect(r.updated).toBe(1);
    const row = await oneByTenantSlug(ctx, tenantA, "gatechange");
    expect(row.gates_tools).toEqual(["g_a", "g_b"]);
  });
});

describe("applySkillSeedsForAllTenants — per-tenant fanout", () => {
  test("each tenant gets its own seed row; updates are isolated", async () => {
    const loaded = loadSkillSeedsFromContent([
      source("broadcast", validSeedMd({ slug: "broadcast", body: "# v1" })),
    ]);
    const seeds = loaded.skills;
    const outcomes = await applySkillSeedsForAllTenants(seeds, ctx.db);
    const a = outcomes.find((o) => o.tenant_id === tenantA)!;
    const b = outcomes.find((o) => o.tenant_id === tenantB)!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    const rA = await oneByTenantSlug(ctx, tenantA, "broadcast");
    const rB = await oneByTenantSlug(ctx, tenantB, "broadcast");
    expect(rA.body).toContain("# v1");
    expect(rB.body).toContain("# v1");
  });
});

describe("loadSkillSeedsFromContent — migration 0006 contract", () => {
  test("legacy `auto_load` key reports legacy_field", () => {
    const r = loadSkillSeedsFromContent([
      source(
        "legacy",
        [
          "---",
          "slug: legacy",
          "scope: global",
          "title: T",
          "description: D",
          "auto_load: true",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("legacy_field");
  });

  test("legacy `trigger_keywords` key reports legacy_field", () => {
    const r = loadSkillSeedsFromContent([
      source(
        "legacy",
        [
          "---",
          "slug: legacy",
          "scope: global",
          "title: T",
          "description: D",
          "trigger_keywords: [a, b]",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("legacy_field");
  });

  test("activates_when parses inline JSON of discriminated objects", () => {
    const r = loadSkillSeedsFromContent([
      source(
        "rich",
        [
          "---",
          "slug: rich",
          "scope: global",
          "title: T",
          "description: D",
          'activates_when: [{"kind":"baseline"},{"kind":"tool","tool":"probe_connector"},{"kind":"intent_keyword","word":"customers"}]',
          "side_effects: write",
          "idempotency: key_required",
          "maturity: experimental",
          "tags: [stripe, payments]",
          'input_schema: {"type":"object","required":["x"],"properties":{"x":{"type":"string"}}}',
          'output_schema: {"type":"object","properties":{"y":{"type":"number"}}}',
          "version: 2",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors).toEqual([]);
    const s = r.skills[0]!;
    expect(s.activates_when).toHaveLength(3);
    expect(s.activates_when[0]!.kind).toBe("baseline");
    expect(s.side_effects).toBe("write");
    expect(s.idempotency).toBe("key_required");
    expect(s.maturity).toBe("experimental");
    expect(s.tags).toEqual(["stripe", "payments"]);
    expect(s.input_schema).toEqual({
      type: "object",
      required: ["x"],
      properties: { x: { type: "string" } },
    });
    expect(s.output_schema).toEqual({
      type: "object",
      properties: { y: { type: "number" } },
    });
  });

  test("malformed activates_when reports bad_activates_when", () => {
    const r = loadSkillSeedsFromContent([
      source(
        "bad",
        [
          "---",
          "slug: bad",
          "scope: global",
          "title: T",
          "description: D",
          'activates_when: [{"kind":"unknown"}]',
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("bad_activates_when");
  });

  test("invalid side_effects reports bad_side_effects", () => {
    const r = loadSkillSeedsFromContent([
      source(
        "bad",
        [
          "---",
          "slug: bad",
          "scope: global",
          "title: T",
          "description: D",
          "side_effects: nuke",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("bad_side_effects");
  });

  test("every shipped seed file embedded in the binary parses cleanly", () => {
    const r = loadEmbeddedSkillSeeds();
    const reason = r.errors.length === 0 ? "" : `seed parse errors: ${JSON.stringify(r.errors)}`;
    expect(reason).toBe("");
    expect(r.errors).toEqual([]);
    expect(r.skills.length).toBeGreaterThanOrEqual(20);
    for (const s of r.skills) {
      expect(s.slug.length).toBeGreaterThan(0);
      expect(Array.isArray(s.activates_when)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

async function oneByTenantSlug(
  ctx: TestDb,
  tenant_id: string,
  slug: string,
): Promise<{
  body: string;
  version: number;
  seed_source: string | null;
  gates_tools: string[] | null;
}> {
  const rows = await ctx.db
    .select()
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.slug, slug)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`no row for ${tenant_id}/${slug}`);
  return {
    body: row.body,
    version: row.version,
    seed_source: row.seed_source,
    gates_tools: row.gates_tools,
  };
}
