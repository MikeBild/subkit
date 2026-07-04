// Integration tests: assembler renders full bodies only for skills in the
// recency window (loaded_skill_slugs) and demoted skills still appear in
// the "Loaded" index block via loaded_skill_membership.
//
// Design note: the "loaded" full-body path in assembleEnhancedPrompt only
// fires for skills NOT already returned by `retrieveApplicableSkills`
// (global skills are always in scope and render via the Global index). To
// test the recency-controlled full-body vs index path we use:
//   - A connector-scoped skill bound to connector C1 (out-of-scope for
//     an assembly call that passes no connector_id or a different id).
//   - This skill is then referenced via loaded_skill_slugs (full body) or
//     only in loaded_skill_membership (Loaded index one-liner).
//
// These tests require a real Postgres database (testcontainers).
// Set REQUIRES_PG=0 to skip in environments without a DB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, skills, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";

const skip = process.env.REQUIRES_PG === "0";

let db: TestDb;
let tenant_id: string;
// Slug of a connector-scoped skill bound to a connector not in assembly scope.
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

  // Seed a connector — its id is used to scope the skills, but we will
  // NOT pass this connector_id to the assembler, so these skills are
  // out-of-scope for `retrieveApplicableSkills`. They only enter the
  // prompt via loaded_skill_slugs (full body) or loaded_skill_membership
  // (Loaded index), exercising the recency-aware rendering path.
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
        // Only the "full body" skill is in the recency window.
        // No connector_id passed — both connector skills are out-of-scope for retrieveApplicableSkills.
        loaded_skill_slugs: [outOfScopeFullBodySlug],
        loaded_skill_membership: [outOfScopeFullBodySlug, outOfScopeDemotedSlug],
      },
      db.db,
    );

    // The full body marker should appear verbatim for the recency-window skill.
    expect(prompt.system).toContain("FULL_BODY_MARKER_OOS");
    // The rendered body wraps in a "# Skill:" heading.
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
        // "skill-demoted-oos" is aged out — not in the recency subset.
        loaded_skill_slugs: [outOfScopeFullBodySlug],
        loaded_skill_membership: [outOfScopeFullBodySlug, outOfScopeDemotedSlug],
      },
      db.db,
    );

    // The demoted skill must NOT render a full "# Skill:" section (which is what
    // formatSkill produces). The index one-liner may echo the first line of the body
    // as a description snippet (that's intentional in formatSkillIndex), but the
    // full "# Skill: <title>" heading must not appear for the demoted skill.
    expect(prompt.system).not.toContain("# Skill: Demoted OOS Skill");
  });

  test("a demoted out-of-scope skill in membership still appears in the Loaded skill index", async () => {
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

    // The "Loaded" index block is created by formatSkillIndex("Loaded", ...).
    // It lists the slug + title as a one-liner for any out-of-scope demoted skill.
    expect(prompt.system).toContain("Loaded skill index");
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
        // Neither loaded_skill_slugs nor loaded_skill_membership provided.
      },
      db.db,
    );

    // Without membership there should be no "Loaded" index block.
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
        // Same slug in membership — must not duplicate into the Loaded index.
        loaded_skill_membership: [outOfScopeFullBodySlug],
      },
      db.db,
    );

    // The full body appears exactly once.
    const occurrences = (prompt.system.match(/FULL_BODY_MARKER_OOS/g) ?? []).length;
    expect(occurrences).toBe(1);

    // And the Loaded index should NOT appear (no demoted skills outside the full-body set).
    expect(prompt.system).not.toContain("Loaded skill index");
  });

  test("wrong-tenant loaded_skill_slugs resolve to nothing (no body injected, no cross-tenant leak)", async () => {
    // Seed a skill under a different tenant.
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
        tenant_id, // our tenant, not otherTenant
        flow: "generate",
        user_turns: [{ role: "user", content: "help me" }],
        max_tokens: 40_000,
        model: "mock",
        // Reference the other tenant's skill slug.
        loaded_skill_slugs: [otherSkill!.slug!],
        loaded_skill_membership: [otherSkill!.slug!],
      },
      db.db,
    );

    // The cross-tenant body must not appear.
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
      // Import synchronously after the dynamic import above has resolved.
      // Using require() inside a test is fine for pure-function assertions.
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
      // The multi-line body must be collapsed to a one-liner: "Line two" must not appear.
      expect(result).not.toContain("Line two");
    });

    test("loadedSkills route through formatSkill (full body) in the assembler source", () => {
      const { readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const src = join(import.meta.dir, "..", "core", "context-assembler.ts");
      const body = readFileSync(src, "utf-8") as string;
      // Full-body rendering for the recency window.
      expect(body).toMatch(/for \(const s of loadedSkills\) sections\.push\(formatSkill\(/);
      // Loaded index for demoted skills.
      expect(body).toMatch(/formatSkillIndex\("Loaded", loadedIndexSkills/);
    });
  },
);
