import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { AGENT_GUIDE_TAG } from "../../../../agent/briefing.ts";
import { skills, tenants } from "../../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../../db/tests/setup.ts";
import { EMBEDDED_SKILL_SEEDS } from "../../../../skills/embedded-seeds.ts";
import { applySkillSeeds, loadEmbeddedSkillSeeds } from "../../../../skills/seed.ts";

const SEED_DIR = join(import.meta.dir, "..");
const GUIDES = {
  "knowledge-find-and-maintain": ["search_knowledge", "save_learning", "`fact`", "`practice`"],
  "workflow-find-run-check": [
    "find_workflow",
    "run_workflow",
    "get_execution",
    "inspect_execution_step",
  ],
  "when-something-is-stuck": ["diagnose_workflow", "propose_workflow_repair"],
} as const;
const slugs = Object.keys(GUIDES) as (keyof typeof GUIDES)[];

describe("seed skill roster", () => {
  test("every skill file in the seed directory ships in the binary", () => {
    const files = readdirSync(SEED_DIR)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort();
    expect(EMBEDDED_SKILL_SEEDS.map((seed) => seed.file).sort()).toEqual(files);
  });
});

describe("agent guide skills", () => {
  const loaded = loadEmbeddedSkillSeeds();

  test("each guide parses, is global and is tagged for the briefing", () => {
    expect(loaded.errors).toEqual([]);
    for (const slug of slugs) {
      const skill = loaded.skills.find((s) => s.slug === slug);
      expect(skill?.scope).toBe("global");
      expect(skill?.tags).toContain(AGENT_GUIDE_TAG);
      expect(skill?.side_effects).toBe("read");
      expect(skill?.activates_when.some((rule) => rule.kind === "baseline")).toBe(false);
    }
  });

  test("each guide names the tools it teaches", () => {
    for (const slug of slugs) {
      const body = loaded.skills.find((s) => s.slug === slug)?.body ?? "";
      for (const word of GUIDES[slug]) expect(body).toContain(word);
    }
  });

  test("only the three guides carry the briefing tag", () => {
    const tagged = loaded.skills.filter((s) => s.tags.includes(AGENT_GUIDE_TAG)).map((s) => s.slug);
    expect(tagged.sort()).toEqual([...slugs].sort());
  });
});

describe("agent guide skills in a tenant", () => {
  let testDb: TestDb;
  let tenant_id: string;

  beforeAll(async () => {
    testDb = await createTestDb("agent_guide_skills");
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-agent-guides", display_name: "Guides" })
      .returning();
    if (!tenant) throw new Error("seed tenant failed");
    tenant_id = tenant.id;
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  }, 30_000);

  test("are seeded active for chat and authoring alike", async () => {
    await applySkillSeeds(loadEmbeddedSkillSeeds().skills, tenant_id, testDb.db);
    const rows = await testDb.db
      .select({ slug: skills.slug, lifecycle: skills.lifecycle, applies_to: skills.applies_to })
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), inArray(skills.slug, [...slugs])));
    expect(rows.sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? ""))).toEqual(
      [...slugs].sort().map((slug) => ({ slug, lifecycle: "active", applies_to: "both" })),
    );
  });
});
