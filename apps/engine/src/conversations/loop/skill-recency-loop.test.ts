// Loop-level integration test for the smart skill loader's index-safety
// contract.
//
// The assembler-only test (`skill-recency-assembler.test.ts`) hand-feeds
// `loaded_skill_membership`, which MASKS the upstream prune bug: if the
// loop pruned a demoted slug out of membership the moment it left the
// full-body window, the assembler would never see it and its index-safety
// block would be dead code in production.
//
// This test drives the REAL loop recency seam — the exact code path the
// conversation loop runs on a continuation turn:
//
//   refresh = baseline ∪ reaffirmLoadedForTurn(...)   (no topical match)
//   recency = applyRecency(loaded, turn, refresh, [], neverPrune)
//   persist recency.next ; assemble with membership = recency.membership
//
// over K idle turns, then feeds the PERSISTED membership into the real
// `assembleEnhancedPrompt`. It asserts an out-of-scope (experimental,
// `load_skill`-only) loaded skill:
//   - leaves the full-body set after K idle turns (cost control), AND
//   - STILL renders in the "Loaded" index (no skill disappears).
//
// Pre-fix, the slug was pruned from membership at age K, the assembler
// rendered no Loaded block, and the gated skill was unreachable — this
// test would fail at the "Loaded" index assertion.
//
// Requires a real Postgres database (testcontainers). Set REQUIRES_PG=0
// to skip in environments without a DB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, skills, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { assembleEnhancedPrompt } from "../../llm/core/context-assembler.ts";
import {
  listBaselineSlugs,
  loadActivationCatalog,
  reaffirmLoadedForTurn,
} from "../skill-autoload.ts";
import { applyRecency, type LoadedSkillEntry, SKILL_FULL_BODY_RECENCY_K } from "./skill-recency.ts";

const skip = process.env.REQUIRES_PG === "0";
const K = SKILL_FULL_BODY_RECENCY_K;

let db: TestDb;
let tenant_id: string;
// An experimental (load_skill-only) CONNECTOR-scoped skill bound to a
// connector we never pass to the assembler. Global skills always render
// via the Global index, so to exercise the "lives in NO scope index"
// category the demoted skill must be connector-scoped-but-out-of-scope.
// Experimental on top means it also never matches `activates_when`, so
// the loop never re-affirms it — the worst case for index-safety.
let experimentalSlug: string;
// A baseline GLOBAL skill — refreshed every turn, always full-body.
// Present so the continuation-turn refresh set is non-empty (production).
let baselineSlug: string;

beforeAll(async () => {
  if (skip) return;
  db = await createTestDb("skill_recency_loop");

  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-recency-loop", display_name: "Recency Loop Test" })
    .returning();
  tenant_id = t!.id;

  // A connector that is NOT passed to the assembler — its skill is
  // therefore out-of-scope for retrieveApplicableSkills.
  const [conn] = await db.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "oos-loop-connector",
      display_name: "OOS Loop Connector",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    })
    .returning();

  const [exp, base] = await db.db
    .insert(skills)
    .values([
      {
        tenant_id,
        slug: "experimental-loadme",
        title: "Experimental Load-Me Skill",
        body: "EXPERIMENTAL_BODY_MARKER: only via load_skill; ages out to the index.",
        scope: "connector",
        connector_id: conn!.id,
        lifecycle: "active",
        source: "template",
        maturity: "experimental",
        // No activation rules: never re-affirmed by a turn's signals.
        activates_when: [],
      },
      {
        tenant_id,
        slug: "baseline-core",
        title: "Baseline Core Skill",
        body: "BASELINE_BODY_MARKER: core mental model, always full-body.",
        scope: "global",
        lifecycle: "active",
        source: "template",
        maturity: "stable",
        activates_when: [{ kind: "baseline" }],
      },
    ])
    .returning();
  experimentalSlug = exp!.slug!;
  baselineSlug = base!.slug!;
}, 60_000);

afterAll(async () => {
  if (!skip && db?.cleanup) await db.cleanup();
}, 30_000);

describe.skipIf(skip)("loop recency seam → assembler index-safety", () => {
  test("an out-of-scope experimental skill demotes after K idle turns but still renders in the Loaded index", async () => {
    const catalog = await loadActivationCatalog(tenant_id, db.db);
    const baselineSlugSet = new Set(listBaselineSlugs(catalog));
    expect(baselineSlugSet.has(baselineSlug)).toBe(true);

    // Turn 1: both skills loaded full-body (the experimental one via an
    // explicit load_skill, the baseline via boot). Seed the recency state
    // exactly as the loop persists it on turn 1.
    let loaded: LoadedSkillEntry[] = [
      { slug: experimentalSlug, last_turn: 1 },
      { slug: baselineSlug, last_turn: 1 },
    ];

    // Drive K idle continuation turns. On a continuation turn the loop's
    // refresh set is `baseline ∪ reaffirmed`; the experimental skill is
    // neither baseline nor re-affirmable (no activation rules, and it is
    // experimental), so it is never refreshed and ages out.
    let lastRecency = applyRecency(loaded, 1, new Set([baselineSlug]), [], baselineSlugSet);
    for (let turn = 2; turn <= 1 + K; turn += 1) {
      const loadedSlugs = loaded.map((e) => e.slug);
      const reaffirmed = reaffirmLoadedForTurn(
        {
          mode: "user_turn",
          user_text: "yes", // continuation-style: no topical signal
          connector_drivers: [],
          connector_templates: [],
        },
        catalog,
        loadedSlugs,
      );
      const refresh = new Set<string>([
        ...loadedSlugs.filter((s) => baselineSlugSet.has(s)),
        ...reaffirmed,
      ]);
      lastRecency = applyRecency(loaded, turn, refresh, [], baselineSlugSet);
      loaded = lastRecency.next;
    }

    // After K idle turns: the experimental skill left the full-body set...
    expect(lastRecency.fullBodySet).not.toContain(experimentalSlug);
    // ...but it is STILL in membership (NOT pruned at the demotion boundary).
    expect(lastRecency.membership).toContain(experimentalSlug);
    // The baseline stays full-body throughout.
    expect(lastRecency.fullBodySet).toContain(baselineSlug);

    // Now assemble a prompt with EXACTLY what the loop would pass: the
    // recency-filtered full-body set and the full membership. No
    // connector_id → the experimental skill is out of every scope index.
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "yes" }],
        max_tokens: 40_000,
        model: "mock",
        loaded_skill_slugs: lastRecency.fullBodySet,
        loaded_skill_membership: lastRecency.membership,
      },
      db.db,
    );

    // The demoted experimental skill must NOT render its full "# Skill:"
    // section (that heading is what formatSkill produces for a full body).
    // The index one-liner may echo the body's first line as a snippet
    // (intentional in formatSkillIndex), so we assert on the heading, not
    // the marker text.
    expect(prompt.system).not.toContain("# Skill: Experimental Load-Me Skill");
    // ...but it MUST appear in the "Loaded" index so it stays referenceable
    // and `load_skill`-reaffirmable (the no-skill-disappears contract).
    expect(prompt.system).toContain("Loaded skill index");
    expect(prompt.system).toContain(experimentalSlug);
    expect(prompt.system).toContain("Experimental Load-Me Skill");
  });
});
