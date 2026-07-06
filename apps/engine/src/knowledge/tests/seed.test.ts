// Knowledge-seed loader tests.
//
// Coverage:
//   - frontmatter parsing: happy path, missing keys, bad scope, bad yaml
//   - loadEmbeddedKnowledgeSeeds: all 6 files parse, scope = global, slugs present
//   - content-hash drift detection: second apply of unchanged seed is a no-op
//   - apply creates rows with correct shape
//   - body change → UPDATE with rotated version fingerprint
//   - per-tenant isolation: two tenants each get their own rows
//   - FTS search: embedded sk-platform-reference content is findable after apply
//   - 5 new seed skills: intent_keyword activates_when, kebab slugs, no dotted MCP names

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { knowledgeSources, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { loadEmbeddedSkillSeeds } from "../../skills/seed.ts";
import {
  applyKnowledgeSeeds,
  applyKnowledgeSeedsForAllTenants,
  loadEmbeddedKnowledgeSeeds,
  loadKnowledgeSeedsFromContent,
  type SeedSource,
} from "../seed.ts";
import { searchKnowledge } from "../service.ts";

// Requires a real Postgres database — set REQUIRES_PG=0 to skip DB tests in
// environments without a live Postgres.
const skip = process.env.REQUIRES_PG === "0";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validKnowledgeMd(opts: {
  slug: string;
  name?: string;
  description?: string;
  tags?: string[];
  scope?: string;
  body?: string;
  version?: number;
}): string {
  const tagsLine = opts.tags ? `tags: [${opts.tags.join(", ")}]` : "tags: []";
  return [
    "---",
    `slug: ${opts.slug}`,
    `name: ${opts.name ?? "Test Knowledge Source"}`,
    `description: ${opts.description ?? "A test knowledge source."}`,
    tagsLine,
    `scope: ${opts.scope ?? "global"}`,
    `version: ${opts.version ?? 1}`,
    "---",
    "",
    opts.body ?? "# Body\n\nSomething useful here.",
  ].join("\n");
}

function src(name: string, content: string): SeedSource {
  return { file: `${name}.md`, content };
}

// ---------------------------------------------------------------------------
// DB setup — shared across DB-backed describe blocks
// ---------------------------------------------------------------------------

let dbCtx: TestDb;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  if (skip) return;
  dbCtx = await createTestDb("knowledge_seed");
  const [a] = await dbCtx.db
    .insert(tenants)
    .values({ slug: "t-kseed-a", display_name: "Knowledge Seed A" })
    .returning();
  const [b] = await dbCtx.db
    .insert(tenants)
    .values({ slug: "t-kseed-b", display_name: "Knowledge Seed B" })
    .returning();
  if (!a || !b) throw new Error("seed tenants failed");
  tenantA = a.id;
  tenantB = b.id;
}, 60_000);

afterAll(async () => {
  if (!skip && dbCtx?.cleanup) await dbCtx.cleanup();
}, 30_000);

// ---------------------------------------------------------------------------
// Pure — loadEmbeddedKnowledgeSeeds()
// ---------------------------------------------------------------------------

describe("loadEmbeddedKnowledgeSeeds — all 7 embedded files", () => {
  test("parses all 7 files with 0 errors", () => {
    const r = loadEmbeddedKnowledgeSeeds();
    const reason = r.errors.length === 0 ? "" : `seed parse errors: ${JSON.stringify(r.errors)}`;
    expect(reason).toBe("");
    expect(r.errors).toEqual([]);
    expect(r.knowledge.length).toBe(7);
    expect(r.embedded_count).toBe(7);
  });

  test("every embedded knowledge seed has scope 'global'", () => {
    const r = loadEmbeddedKnowledgeSeeds();
    for (const k of r.knowledge) {
      expect(k.scope).toBe("global");
    }
  });

  test("all 7 expected slugs are present", () => {
    const r = loadEmbeddedKnowledgeSeeds();
    const slugs = new Set(r.knowledge.map((k) => k.slug));
    const expected = [
      "sk-ref-chat",
      "sk-ref-mcp-tools",
      "sk-ref-rest-api",
      "sk-ref-cli",
      "sk-ref-status",
      "sk-ref-webhooks",
      "sk-ref-knowledge-and-skills",
    ];
    for (const slug of expected) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  test("sk-ref-cli seed documents the engine-served install one-liner and never npm or a public GitHub link", () => {
    const r = loadEmbeddedKnowledgeSeeds();
    const cli = r.knowledge.find((k) => k.slug === "sk-ref-cli");
    expect(cli).toBeDefined();
    // P1: the real install path is the engine-served `/install` one-liner —
    // it must be present so retrieval grounds the bot on the working answer.
    expect(cli!.body).toContain("/install");
    expect(cli!.body).toContain("curl -fsSL <engine-url>/install | bash");
    expect(cli!.body).toContain("~/.subkit/bin");
    // The hallucinated npm package must never appear in retrievable knowledge,
    // even as a negation — the seed content must not re-introduce the string.
    expect(cli!.body).not.toContain("@subkit/cli");
    // The GitHub repo is private, so a raw.githubusercontent / releases link is
    // a dead end for users. The seed must not offer one as an install source.
    expect(cli!.body).not.toContain("raw.githubusercontent.com");
    expect(cli!.body).not.toContain("github.com");
  });

  test("every embedded seed has a non-empty name, description, body, and tags array", () => {
    const r = loadEmbeddedKnowledgeSeeds();
    for (const k of r.knowledge) {
      expect(k.slug.length).toBeGreaterThan(0);
      expect(k.name.length).toBeGreaterThan(0);
      expect(k.description.length).toBeGreaterThan(0);
      expect(k.body.length).toBeGreaterThan(0);
      expect(Array.isArray(k.tags)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure — loadKnowledgeSeedsFromContent() happy path
// ---------------------------------------------------------------------------

describe("loadKnowledgeSeedsFromContent — happy path", () => {
  test("parses a valid entry and extracts all frontmatter fields", () => {
    const r = loadKnowledgeSeedsFromContent([
      src("a", validKnowledgeMd({ slug: "my-ref", name: "My Reference", tags: ["api", "docs"] })),
    ]);
    expect(r.errors).toEqual([]);
    expect(r.knowledge).toHaveLength(1);
    const k = r.knowledge[0]!;
    expect(k.slug).toBe("my-ref");
    expect(k.name).toBe("My Reference");
    expect(k.tags).toEqual(["api", "docs"]);
    expect(k.scope).toBe("global");
    expect(k.body).toContain("Something useful here");
  });

  test("body does not include the frontmatter block", () => {
    const r = loadKnowledgeSeedsFromContent([
      src("b", validKnowledgeMd({ slug: "clean", body: "# Real Body\n\nHello world." })),
    ]);
    const k = r.knowledge[0]!;
    expect(k.body).not.toContain("---");
    expect(k.body).not.toContain("slug:");
    expect(k.body).toContain("Hello world");
  });

  test("empty input returns empty result with embedded_count 0", () => {
    const r = loadKnowledgeSeedsFromContent([]);
    expect(r.knowledge).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.embedded_count).toBe(0);
  });

  test("mixed valid and invalid: valid entries in knowledge, invalid entries in errors", () => {
    const r = loadKnowledgeSeedsFromContent([
      src("ok", validKnowledgeMd({ slug: "ok-seed" })),
      src("bad", "no frontmatter here"),
    ]);
    expect(r.knowledge).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.knowledge[0]!.slug).toBe("ok-seed");
    expect(r.errors[0]!.code).toBe("missing_frontmatter");
    expect(r.embedded_count).toBe(2);
  });

  test("version from frontmatter is parsed as a number", () => {
    const r = loadKnowledgeSeedsFromContent([
      src("v", validKnowledgeMd({ slug: "versioned", version: 3 })),
    ]);
    expect(r.knowledge[0]!.version).toBe(3);
  });

  test("tags flow-array is parsed into a string array", () => {
    const r = loadKnowledgeSeedsFromContent([
      src("tagged", validKnowledgeMd({ slug: "tagged", tags: ["alpha", "beta", "gamma"] })),
    ]);
    expect(r.knowledge[0]!.tags).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ---------------------------------------------------------------------------
// Pure — loadKnowledgeSeedsFromContent() error paths
// ---------------------------------------------------------------------------

describe("loadKnowledgeSeedsFromContent — error paths", () => {
  test("missing frontmatter reports missing_frontmatter", () => {
    const r = loadKnowledgeSeedsFromContent([src("x", "no frontmatter here")]);
    expect(r.knowledge).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("missing_frontmatter");
    expect(r.errors[0]!.file).toBe("x.md");
  });

  test("missing required key 'slug' reports missing_key", () => {
    const r = loadKnowledgeSeedsFromContent([
      src(
        "noslug",
        [
          "---",
          "name: N",
          "description: D",
          "tags: []",
          "scope: global",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("missing_key");
  });

  test("missing required key 'name' reports missing_key", () => {
    const r = loadKnowledgeSeedsFromContent([
      src(
        "noname",
        [
          "---",
          "slug: noname",
          "description: D",
          "tags: []",
          "scope: global",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("missing_key");
  });

  test("missing required key 'description' reports missing_key", () => {
    const r = loadKnowledgeSeedsFromContent([
      src(
        "nodesc",
        [
          "---",
          "slug: nodesc",
          "name: N",
          "tags: []",
          "scope: global",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("missing_key");
  });

  test("bad scope reports bad_scope", () => {
    const r = loadKnowledgeSeedsFromContent([
      src(
        "weird",
        [
          "---",
          "slug: w",
          "name: W",
          "description: D",
          "tags: []",
          "scope: universe",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("bad_scope");
  });

  test("malformed yaml line (no colon) reports bad_yaml", () => {
    const r = loadKnowledgeSeedsFromContent([
      src(
        "y",
        [
          "---",
          "slug: y",
          "NoColonHere",
          "name: Y",
          "description: D",
          "tags: []",
          "scope: global",
          "version: 1",
          "---",
          "body",
        ].join("\n"),
      ),
    ]);
    expect(r.errors[0]!.code).toBe("bad_yaml");
  });
});

// ---------------------------------------------------------------------------
// Pure — 5 new seed skills (skill parser contract)
// ---------------------------------------------------------------------------

const NEW_SKILL_SLUGS = [
  "webhooks-and-triggers",
  "engine-rest-api",
  "engine-status-and-capabilities",
  "external-chat-integration",
  "sk-cli-reference",
] as const;

describe("5 new seed skills — skill parser contract", () => {
  test("all 5 new skill slugs are present in the embedded skill catalogue", () => {
    const r = loadEmbeddedSkillSeeds();
    const reason = r.errors.length === 0 ? "" : `skill parse errors: ${JSON.stringify(r.errors)}`;
    expect(reason).toBe("");
    const slugs = new Set(r.skills.map((s) => s.slug));
    for (const slug of NEW_SKILL_SLUGS) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  test("each new skill has at least one intent_keyword entry in activates_when", () => {
    const r = loadEmbeddedSkillSeeds();
    const bySlug = new Map(r.skills.map((s) => [s.slug, s]));
    for (const slug of NEW_SKILL_SLUGS) {
      const skill = bySlug.get(slug)!;
      expect(skill).toBeDefined();
      const hasIntentKeyword = skill.activates_when.some((a) => a.kind === "intent_keyword");
      if (!hasIntentKeyword) {
        throw new Error(
          `${slug}: expected at least one intent_keyword in activates_when, got ${JSON.stringify(skill.activates_when)}`,
        );
      }
      expect(hasIntentKeyword).toBe(true);
    }
  });

  test("every new skill slug is kebab-case (lowercase, hyphens only — no uppercase or dots)", () => {
    for (const slug of NEW_SKILL_SLUGS) {
      // Slug must consist of lowercase letters, digits, and hyphens only.
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("no new skill has dotted MCP tool names in gates_tools or activates_when tool entries", () => {
    // MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$ — dots are rejected by
    // Anthropic/claude.ai.  Check the parsed structured fields, not prose, so
    // legitimate property-access notation in examples (e.g. `result.data`) is
    // not incorrectly flagged.
    const r = loadEmbeddedSkillSeeds();
    const bySlug = new Map(r.skills.map((s) => [s.slug, s]));
    for (const slug of NEW_SKILL_SLUGS) {
      const skill = bySlug.get(slug)!;

      // gates_tools must not contain dots
      for (const toolName of skill.gates_tools) {
        expect(toolName).not.toContain(".");
      }

      // activates_when entries of kind "tool" must not have dots in the tool field
      for (const activation of skill.activates_when) {
        if (activation.kind === "tool") {
          expect(activation.tool).not.toContain(".");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// DB — applyKnowledgeSeeds upsert semantics
// ---------------------------------------------------------------------------

describe.skipIf(skip)("applyKnowledgeSeeds — DB upsert semantics", () => {
  test("inserts rows on first apply; second apply of same body is all unchanged", async () => {
    const loaded = loadKnowledgeSeedsFromContent([
      src("alpha", validKnowledgeMd({ slug: "ks-alpha", tags: ["ref"] })),
      src("beta", validKnowledgeMd({ slug: "ks-beta" })),
    ]);
    expect(loaded.errors).toEqual([]);

    const first = await applyKnowledgeSeeds(loaded.knowledge, tenantA, dbCtx.db);
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);
    expect(first.tenant_id).toBe(tenantA);

    // Second apply with identical bodies → all unchanged, no duplicate rows
    const second = await applyKnowledgeSeeds(loaded.knowledge, tenantA, dbCtx.db);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(2);

    // Verify exactly 2 rows exist for this tenant (no duplicates)
    const rows = await dbCtx.db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.tenant_id, tenantA), eq(knowledgeSources.slug, "ks-alpha")));
    expect(rows.length).toBe(1);
  });

  test("body change → UPDATE + rotated version fingerprint", async () => {
    const v1 = loadKnowledgeSeedsFromContent([
      src(
        "evolve",
        validKnowledgeMd({
          slug: "ks-evolve",
          body: "# Evolve v1\n\nInitial content.",
        }),
      ),
    ]);
    await applyKnowledgeSeeds(v1.knowledge, tenantB, dbCtx.db);

    const [row1] = await dbCtx.db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.tenant_id, tenantB), eq(knowledgeSources.slug, "ks-evolve")));
    expect(row1).toBeDefined();
    const versionBefore = row1!.version;

    const v2 = loadKnowledgeSeedsFromContent([
      src(
        "evolve",
        validKnowledgeMd({
          slug: "ks-evolve",
          body: "# Evolve v2\n\nUpdated content with new material.",
        }),
      ),
    ]);
    const result = await applyKnowledgeSeeds(v2.knowledge, tenantB, dbCtx.db);
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.unchanged).toBe(0);

    const [row2] = await dbCtx.db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.tenant_id, tenantB), eq(knowledgeSources.slug, "ks-evolve")));
    expect(row2).toBeDefined();
    // Version fingerprint must have rotated to reflect the new content
    expect(row2!.version).not.toBe(versionBefore);
  });
});

// ---------------------------------------------------------------------------
// DB — applyKnowledgeSeedsForAllTenants per-tenant fanout
// ---------------------------------------------------------------------------

describe.skipIf(skip)("applyKnowledgeSeedsForAllTenants — per-tenant fanout", () => {
  test("each of 2 tenants gets its own row per slug; rows are tenant-isolated", async () => {
    const loaded = loadKnowledgeSeedsFromContent([
      src("broadcast", validKnowledgeMd({ slug: "ks-broadcast", body: "# Broadcast\n\nHello." })),
    ]);
    const seeds = loaded.knowledge;
    const outcomes = await applyKnowledgeSeedsForAllTenants(seeds, dbCtx.db);

    // Both tenants must appear in the outcomes
    const outcomeA = outcomes.find((o) => o.tenant_id === tenantA);
    const outcomeB = outcomes.find((o) => o.tenant_id === tenantB);
    expect(outcomeA).toBeDefined();
    expect(outcomeB).toBeDefined();

    // Each tenant gets its own row
    const rowsA = await dbCtx.db
      .select()
      .from(knowledgeSources)
      .where(
        and(eq(knowledgeSources.tenant_id, tenantA), eq(knowledgeSources.slug, "ks-broadcast")),
      );
    const rowsB = await dbCtx.db
      .select()
      .from(knowledgeSources)
      .where(
        and(eq(knowledgeSources.tenant_id, tenantB), eq(knowledgeSources.slug, "ks-broadcast")),
      );
    expect(rowsA.length).toBe(1);
    expect(rowsB.length).toBe(1);

    // Rows belong to the correct tenant
    expect(rowsA[0]!.tenant_id).toBe(tenantA);
    expect(rowsB[0]!.tenant_id).toBe(tenantB);
  });

  test("second apply-all run is fully idempotent (all unchanged)", async () => {
    const loaded = loadKnowledgeSeedsFromContent([
      src(
        "idem",
        validKnowledgeMd({ slug: "ks-idem", body: "# Idempotent\n\nSame body each time." }),
      ),
    ]);
    const seeds = loaded.knowledge;

    // First apply to seed both tenants
    await applyKnowledgeSeedsForAllTenants(seeds, dbCtx.db);

    // Second apply must report 0 inserted, 0 updated for every tenant
    const second = await applyKnowledgeSeedsForAllTenants(seeds, dbCtx.db);
    for (const o of second) {
      expect(o.inserted).toBe(0);
      expect(o.updated).toBe(0);
      expect(o.unchanged).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// DB — searchKnowledge with seeded sk-platform-reference content
// ---------------------------------------------------------------------------

describe.skipIf(skip)("searchKnowledge — FTS over seeded sk-platform-reference content", () => {
  let searchTenantId: string;

  beforeAll(async () => {
    if (skip) return;
    // Create a dedicated tenant for the FTS tests so the embedded seeds land
    // in an isolated namespace that other describe blocks don't touch.
    const [t] = await dbCtx.db
      .insert(tenants)
      .values({ slug: "t-kseed-fts", display_name: "Knowledge Seed FTS" })
      .returning();
    if (!t) throw new Error("fts tenant failed");
    searchTenantId = t.id;

    // Apply all embedded knowledge seeds to this tenant
    const { knowledge } = loadEmbeddedKnowledgeSeeds();
    const outcome = await applyKnowledgeSeeds(knowledge, searchTenantId, dbCtx.db);
    // All 7 seeds must have been inserted (this is a fresh tenant)
    expect(outcome.inserted).toBe(7);
  }, 30_000);

  test("'login' returns at least one hit (sk-ref-cli covers sk login command)", async () => {
    const hits = await searchKnowledge({ tenant_id: searchTenantId, query: "login" }, dbCtx.db);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toBeDefined();
    expect(hits[0]!.rank).toBeGreaterThan(0);
  });

  test("'executions' returns at least one hit (sk-ref-rest-api covers POST /v1/executions)", async () => {
    const hits = await searchKnowledge(
      { tenant_id: searchTenantId, query: "executions" },
      dbCtx.db,
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  test("'signature' returns at least one hit (sk-ref-webhooks covers signature verification)", async () => {
    const hits = await searchKnowledge({ tenant_id: searchTenantId, query: "signature" }, dbCtx.db);
    expect(hits.length).toBeGreaterThan(0);
  });

  test("all FTS hits belong to the seeded tenant (not another tenant)", async () => {
    const hits = await searchKnowledge({ tenant_id: searchTenantId, query: "webhook" }, dbCtx.db);
    expect(hits.length).toBeGreaterThan(0);
    // Every hit must come from a knowledge source owned by searchTenantId
    for (const hit of hits) {
      // The hit's knowledge_source_id must reference a row belonging to searchTenantId
      const [row] = await dbCtx.db
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, hit.knowledge_source_id));
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe(searchTenantId);
    }
  });

  test("wrong tenant ID returns no FTS hits from the seed tenant (isolation)", async () => {
    // tenantA has no knowledge sources with the same seed content applied to
    // searchTenantId, so searching from tenantA for seed-specific terms
    // must return no cross-tenant hits.
    const wrongTenantHits = await searchKnowledge(
      { tenant_id: tenantA, query: "signature verification webhook" },
      dbCtx.db,
    );
    // All returned hits (if any) must NOT come from searchTenantId's sources
    for (const hit of wrongTenantHits) {
      const [row] = await dbCtx.db
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, hit.knowledge_source_id));
      if (row) {
        expect(row.tenant_id).not.toBe(searchTenantId);
      }
    }
  });
});
