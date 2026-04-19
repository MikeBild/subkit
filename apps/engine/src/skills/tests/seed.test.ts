// Skill-seed loader tests.
//
// Coverage:
//   - frontmatter parsing: happy path, missing keys, bad scope, bad yaml
//   - content-hash drift detection: second apply of unchanged seed is a no-op
//   - apply creates row with correct shape
//   - apply updates body + gates_tools + bumps version when hash differs
//   - per-tenant isolation: two tenants each get their own row

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { skills, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  applySkillSeeds,
  applySkillSeedsForAllTenants,
  loadSkillSeedsFromDisk,
  type SeededSkill,
} from "../seed.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;
let tmpDir: string;

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
  tmpDir = await fs.mkdtemp("/tmp/sk-seed-");
});

afterAll(async () => {
  await ctx.cleanup();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSeed(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content, "utf8");
}

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

describe("loadSkillSeedsFromDisk — happy path", () => {
  test("loads all .md files, skips non-md, parses frontmatter", async () => {
    const dir = await fs.mkdtemp("/tmp/sk-seed-happy-");
    try {
      await fs.writeFile(
        path.join(dir, "a.md"),
        validSeedMd({ slug: "a", title: "A title" }),
      );
      await fs.writeFile(
        path.join(dir, "b.md"),
        validSeedMd({ slug: "b", gates: ["tool_x"], body: "# B\n\n- item" }),
      );
      await fs.writeFile(path.join(dir, "README.txt"), "ignored");
      const r = await loadSkillSeedsFromDisk(dir);
      expect(r.errors).toEqual([]);
      expect(r.skills).toHaveLength(2);
      const a = r.skills.find((s) => s.slug === "a")!;
      expect(a.title).toBe("A title");
      expect(a.gates_tools).toEqual([]);
      const b = r.skills.find((s) => s.slug === "b")!;
      expect(b.gates_tools).toEqual(["tool_x"]);
      expect(b.body).toContain("- item");
      expect(b.body_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("missing directory returns empty result, not an error", async () => {
    const r = await loadSkillSeedsFromDisk("/tmp/does-not-exist-seed-dir");
    expect(r.skills).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe("loadSkillSeedsFromDisk — error paths", () => {
  test("missing frontmatter reports missing_frontmatter", async () => {
    const dir = await fs.mkdtemp("/tmp/sk-seed-err-");
    try {
      await fs.writeFile(path.join(dir, "x.md"), "no frontmatter here");
      const r = await loadSkillSeedsFromDisk(dir);
      expect(r.skills).toEqual([]);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.code).toBe("missing_frontmatter");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("missing required key reports missing_key", async () => {
    const dir = await fs.mkdtemp("/tmp/sk-seed-err-");
    try {
      await fs.writeFile(
        path.join(dir, "nope.md"),
        "---\nslug: x\n---\nbody",
      );
      const r = await loadSkillSeedsFromDisk(dir);
      expect(r.errors[0]!.code).toBe("missing_key");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("bad scope reports bad_scope", async () => {
    const dir = await fs.mkdtemp("/tmp/sk-seed-err-");
    try {
      await fs.writeFile(
        path.join(dir, "weird.md"),
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
      );
      const r = await loadSkillSeedsFromDisk(dir);
      expect(r.errors[0]!.code).toBe("bad_scope");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("malformed yaml line reports bad_yaml", async () => {
    const dir = await fs.mkdtemp("/tmp/sk-seed-err-");
    try {
      await fs.writeFile(
        path.join(dir, "y.md"),
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
      );
      const r = await loadSkillSeedsFromDisk(dir);
      expect(r.errors[0]!.code).toBe("bad_yaml");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("applySkillSeeds — DB upsert semantics", () => {
  test("inserts rows on first apply, unchanged on second", async () => {
    await writeSeed("alpha", validSeedMd({ slug: "alpha" }));
    await writeSeed("beta", validSeedMd({ slug: "beta", gates: ["tool_b"] }));
    const loaded = await loadSkillSeedsFromDisk(tmpDir);
    expect(loaded.errors).toEqual([]);

    const first = await applySkillSeeds(loaded.skills, tenantA, ctx.db);
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);

    const second = await applySkillSeeds(loaded.skills, tenantA, ctx.db);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(2);

    // Every seed row has gates_tools + slug + seed_source stored.
    const rows = await ctx.db
      .select()
      .from(skills)
      .where(eq(skills.tenant_id, tenantA));
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
    const mdA = validSeedMd({
      slug: "evolve",
      body: "# Evolve v1\n\nInitial body.",
    });
    const mdB = validSeedMd({
      slug: "evolve",
      body: "# Evolve v2\n\nNew body with more detail.",
    });

    await writeSeed("evolve", mdA);
    const v1 = await loadSkillSeedsFromDisk(tmpDir);
    const a1 = await applySkillSeeds(v1.skills, tenantB, ctx.db);
    expect(a1.inserted).toBeGreaterThan(0);
    const row1 = await oneByTenantSlug(ctx, tenantB, "evolve");
    expect(row1.version).toBe(1);

    await writeSeed("evolve", mdB);
    const v2 = await loadSkillSeedsFromDisk(tmpDir);
    const a2 = await applySkillSeeds(
      v2.skills.filter((s) => s.slug === "evolve"),
      tenantB,
      ctx.db,
    );
    expect(a2.updated).toBe(1);
    expect(a2.inserted).toBe(0);
    expect(a2.unchanged).toBe(0);
    const row2 = await oneByTenantSlug(ctx, tenantB, "evolve");
    expect(row2.body).toContain("v2");
    expect(row2.version).toBeGreaterThan(1);
    expect(row2.seed_source).not.toBe(row1.seed_source);
  });

  test("gates_tools change alone triggers UPDATE", async () => {
    const mdA = validSeedMd({ slug: "gatechange", gates: [] });
    const mdB = validSeedMd({ slug: "gatechange", gates: ["g_a", "g_b"] });

    await writeSeed("gatechange", mdA);
    const l1 = await loadSkillSeedsFromDisk(tmpDir);
    await applySkillSeeds(
      l1.skills.filter((s) => s.slug === "gatechange"),
      tenantA,
      ctx.db,
    );

    await writeSeed("gatechange", mdB);
    const l2 = await loadSkillSeedsFromDisk(tmpDir);
    const r = await applySkillSeeds(
      l2.skills.filter((s) => s.slug === "gatechange"),
      tenantA,
      ctx.db,
    );
    expect(r.updated).toBe(1);
    const row = await oneByTenantSlug(ctx, tenantA, "gatechange");
    expect(row.gates_tools).toEqual(["g_a", "g_b"]);
  });
});

describe("applySkillSeedsForAllTenants — per-tenant fanout", () => {
  test("each tenant gets its own seed row; updates are isolated", async () => {
    const mdA = validSeedMd({ slug: "broadcast", body: "# v1" });
    await writeSeed("broadcast", mdA);
    const loaded = await loadSkillSeedsFromDisk(tmpDir);
    const seeds = loaded.skills.filter((s) => s.slug === "broadcast");
    const outcomes = await applySkillSeedsForAllTenants(seeds, ctx.db);
    // Both seed tenants should have gotten one insert; other tenants seeded by
    // the test runner (if any) may also exist, so we only assert our two.
    const a = outcomes.find((o) => o.tenant_id === tenantA)!;
    const b = outcomes.find((o) => o.tenant_id === tenantB)!;
    // Either insert or update — we don't know prior state within this test
    // suite — but the row MUST now exist for both.
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    const rA = await oneByTenantSlug(ctx, tenantA, "broadcast");
    const rB = await oneByTenantSlug(ctx, tenantB, "broadcast");
    expect(rA.body).toContain("# v1");
    expect(rB.body).toContain("# v1");
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
