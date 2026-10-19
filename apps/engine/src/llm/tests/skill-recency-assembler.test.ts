import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, skills, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";

const skip = process.env.REQUIRES_PG === "0";

let db: TestDb;
let tenant_id: string;
let outOfScopeFullBodySlug: string;
let outOfScopeDemotedSlug: string;

beforeAll(async () => {
  if (skip) return;
  db = await createTestDb("skill_recency_assembler");

  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-recency-asm", display_name: "Recency Asm Test" })
    .returning();
  tenant_id = t!.id;

  const [conn] = await db.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "oos-connector",
      display_name: "OOS Connector",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    })
    .returning();
  const connector_id = conn!.id;

  const [s1, s2] = await db.db
    .insert(skills)
    .values([
      {
        tenant_id,
        slug: "skill-full-body-oos",
        title: "Full Body OOS Skill",
        body: "FULL_BODY_MARKER_OOS: This skill body should appear verbatim in the system prompt.",
        scope: "connector",
        connector_id,
        lifecycle: "active",
        source: "template",
      },
      {
        tenant_id,
        slug: "skill-demoted-oos",
        title: "Demoted OOS Skill",
        body: "DEMOTED_BODY_MARKER_OOS: This body must NOT appear in full when skill is demoted.",
        scope: "connector",
        connector_id,
        lifecycle: "active",
        source: "template",
      },
    ])
    .returning();
  outOfScopeFullBodySlug = s1!.slug!;
  outOfScopeDemotedSlug = s2!.slug!;
}, 60_000);

afterAll(async () => {
  if (!skip && db?.cleanup) await db.cleanup();
}, 30_000);

describe.skipIf(skip)("assembler — recency-aware full-body vs index rendering", () => {
  test("a skill in loaded_skill_slugs (out-of-scope) renders its FULL body in the system prompt", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "generate",
        user_turns: [{ role: "user", content: "help me" }],
        max_tokens: 40_000,
        model: "mock",
        loaded_skill_slugs: [outOfScopeFullBodySlug],
        loaded_skill_membership: [outOfScopeFullBodySlug, outOfScopeDemotedSlug],
      },
      db.db,
    );

    expect(prompt.system).toContain("FULL_BODY_MARKER_OOS");
    expect(prompt.system).toContain("# Skill: Full Body OOS Skill");
  });

  test("a demoted skill (in membership but not loaded_skill_slugs) does NOT render its full body", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "generate",
        user_turns: [{ role: "user", content: "help me" }],
        max_tokens: 40_000,
        model: "mock",
        loaded_skill_slugs: [outOfScopeFullBodySlug],
        loaded_skill_membership: [outOfScopeFullBodySlug, outOfScopeDemotedSlug],
      },
      db.db,
    );

    expect(prompt.system).not.toContain("# Skill: Demoted OOS Skill");
  });

  test("a demoted out-of-scope skill in membership still appears in the Loaded skill catalog", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "generate",
        user_turns: [{ role: "user", content: "help me" }],
        max_tokens: 40_000,
        model: "mock",
        loaded_skill_slugs: [outOfScopeFullBodySlug],
        loaded_skill_membership: [outOfScopeFullBodySlug, outOfScopeDemotedSlug],
      },
      db.db,
    );

    expect(prompt.system).toContain("Loaded skill catalog");
    expect(prompt.system).toContain(outOfScopeDemotedSlug);
    expect(prompt.system).toContain("Demoted OOS Skill");
  });

  test("with no loaded_skill_membership, no Loaded index block appears", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "generate",
        user_turns: [{ role: "user", content: "help me" }],
        max_tokens: 40_000,
        model: "mock",
      },
      db.db,
    );

    expect(prompt.system).not.toContain("Loaded skill index");
  });

  test("a skill in both loaded_skill_slugs and membership renders full body exactly once", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "generate",
        user_turns: [{ role: "user", content: "help me" }],
        max_tokens: 40_000,
        model: "mock",
        loaded_skill_slugs: [outOfScopeFullBodySlug],
        loaded_skill_membership: [outOfScopeFullBodySlug],
      },
      db.db,
    );

    const occurrences = (prompt.system.match(/FULL_BODY_MARKER_OOS/g) ?? []).length;
    expect(occurrences).toBe(1);

    expect(prompt.system).not.toContain("Loaded skill index");
  });

  test("wrong-tenant loaded_skill_slugs resolve to nothing (no body injected, no cross-tenant leak)", async () => {
    const [otherTenant] = await db.db
      .insert(tenants)
      .values({ slug: "t-other-recency", display_name: "Other" })
      .returning();

    const [otherConn] = await db.db
      .insert(connectors)
      .values({
        tenant_id: otherTenant!.id,
        slug: "other-conn",
        display_name: "Other Conn",
        driver: "http",
        environment: "dev",
        auth_type: "none",
      })
      .returning();

    const [otherSkill] = await db.db
      .insert(skills)
      .values({
        tenant_id: otherTenant!.id,
        slug: "other-tenant-skill",
        title: "Cross Tenant Skill",
        body: "CROSS_TENANT_BODY: must not leak.",
        scope: "connector",
        connector_id: otherConn!.id,
        lifecycle: "active",
        source: "template",
      })
      .returning();

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "generate",
        user_turns: [{ role: "user", content: "help me" }],
        max_tokens: 40_000,
        model: "mock",
        loaded_skill_slugs: [otherSkill!.slug!],
        loaded_skill_membership: [otherSkill!.slug!],
      },
      db.db,
    );

    expect(prompt.system).not.toContain("CROSS_TENANT_BODY");
  });
});

describe.skipIf(skip)(
  "assembler — static contract: skill-summary-trim (source text assertions)",
  () => {
    test("formatSkillIndex helper is exported from the assembler barrel", async () => {
      const { formatSkillIndex } = await import("../core/context-assembler.ts");
      expect(typeof formatSkillIndex).toBe("function");
    });

    test("formatSkillIndex renders a one-liner per skill with load_skill hint", () => {
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      const mod = require("../core/context-assembler.ts") as any;
      const { formatSkillIndex } = mod;
      const fakeSkills = [
        {
          id: "id-a",
          slug: "my-skill",
          title: "My Skill",
          body: "The body text line one.\nLine two.",
          scope: "global",
          lifecycle: "active",
          examples: [],
          best_practices: [],
          pitfalls: [],
          doc_refs: [],
          connector_id: null,
          workflow_id: null,
          tenant_id: "t",
          version: 1,
          created_at: new Date(FROZEN_NOW),
          updated_at: new Date(FROZEN_NOW),
          activates_when: [],
          gates_tools: [],
          tags: [],
          maturity: "stable",
          source: "template",
          side_effects: "read",
          idempotency: "none",
          input_schema: null,
          output_schema: null,
        },
      ];
      const result = formatSkillIndex("Loaded", fakeSkills);
      expect(result).not.toBeNull();
      expect(result).toContain("Loaded skill index");
      expect(result).toContain("`my-skill`");
      expect(result).toContain("My Skill");
      expect(result).toContain("load_skill");
      expect(result).not.toContain("Line two");
    });

    test("loadedSkills route through formatSkill (full body) in the assembler source", () => {
      const { readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const src = join(import.meta.dir, "..", "core", "context-assembler.ts");
      const body = readFileSync(src, "utf-8") as string;
      expect(body).toMatch(/for \(const s of loadedSkills\) sections\.push\(formatSkill\(/);
      expect(body).toMatch(/formatSkillIndex\(\s*"Loaded",\s*loadedIndexSkills/);
    });
  },
);
