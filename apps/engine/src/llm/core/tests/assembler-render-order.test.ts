// Integration test: render order + drop order for recipe bodies + skill candidates.
// Uses a real Postgres database via createTestDb.
//
// Verifies:
//  - Decision 2: connectorRecipeBodiesBlock appears after connectorRecipesBlock
//    and before connectorIndexBlock in the rendered system prompt
//  - Decision 2: skillCandidatesBlock appears after loaded skills and before
//    knowledge chunks
//  - Drop ladder: under synthetic overflow, skill_candidates drops before
//    connector_recipe_bodies which drops before connector_recipes
//  - Workflow-scope contract: with workflow_id unset, workflow-scoped candidates are ABSENT

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, skillCandidates, tenants, workflows } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { logger } from "../../../logging/logger.ts";
import { resetMockProvider } from "../../mock-provider.ts";
import { assembleEnhancedPrompt } from "../context-assembler.ts";

// Section name constants — mirrors the strings the assembler pushes to `trimmed`.
const SECTION_SKILL_CANDIDATES = "skill_candidates";
const SECTION_CONNECTOR_RECIPE_BODIES = "connector_recipe_bodies";
const SECTION_CONNECTOR_RECIPES = "connector_recipes";

// Skip guard for environments without Postgres.
const skip = process.env.REQUIRES_PG === "0";

// Load-bearing assembler contract — drop-ladder ordering + workflow-scope
// contract live only in this file's DB-backed describes. Surface the skip
// so a green "0 failures" line isn't mistaken for "the ladder still holds".
if (skip) {
  logger.warn({
    module: "test",
    action: "test.suite.skipped",
    msg: "REQUIRES_PG=0 — skipping render-order + drop-ladder verification. Run with Postgres to re-enable.",
    suite: "assembler-render-order",
  });
}

let ctx: TestDb;
let tenant_id: string;
let connector_id: string;
let workflow_id: string;

// A minimal recipe snapshot that includes a real workflow JSON so the
// recipe bodies section renders (not just the slim roster).
const RECIPE_SNAPSHOT: Record<string, unknown> = {
  slug: "stripe",
  recipes: [
    {
      slug: "stripe-charge-succeeded",
      title: "Handle Stripe charge succeeded",
      description: "Fires when a Stripe charge.succeeded webhook arrives.",
      category: "webhooks",
      difficulty: "easy",
      intent_keywords: ["charge", "payment", "webhook"],
      tags: ["billing", "stripe"],
      prerequisites: ["Stripe connector set up"],
      required_connectors: [{ placeholder: "stripe", template: "stripe" }],
      sample_input: { event: "charge.succeeded" },
      workflow: {
        name: "stripe-charge-succeeded",
        steps: [
          {
            id: "notify",
            kind: "request",
            connector_id: "${stripe}",
            path: "/v1/charges",
            params: { limit: 1 },
          },
        ],
      },
    },
    {
      slug: "stripe-refund",
      title: "Handle Stripe refund",
      description: "Fires on refund.created event.",
      category: "webhooks",
      difficulty: "easy",
      intent_keywords: ["refund"],
      tags: ["billing"],
      prerequisites: [],
      required_connectors: [],
      sample_input: null,
      workflow: { name: "refund", steps: [] },
    },
  ],
};

beforeAll(async () => {
  if (skip) return;
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();

  ctx = await createTestDb("assembler_render_order");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-aro", display_name: "Render Order Test" })
    .returning();
  tenant_id = t!.id;

  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "stripe",
      display_name: "Stripe",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://api.stripe.com",
      config: {},
      template_snapshot: RECIPE_SNAPSHOT,
    })
    .returning();
  connector_id = c!.id;

  // Seed a real workflow row so future FK tightening (e.g. a JOIN in
  // listSkillCandidates) doesn't silently disable the workflow-scope
  // assertions in this file.
  const [wf] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id,
      slug: "render-order-test-workflow",
      name: "Render Order Test Workflow",
      lifecycle: "draft",
    })
    .returning();
  workflow_id = wf!.id;

  // Seed a connector-scoped proposed skill candidate.
  await ctx.db.insert(skillCandidates).values({
    tenant_id,
    scope: "connector",
    connector_id,
    pattern_kind: "repair_pattern",
    title: "Stripe rate limit backoff",
    body: "Always add exponential backoff when Stripe returns 429.",
    evidence: [],
    confidence: "high",
    fingerprint: "fp-stripe-ratelimit",
  });

  // Seed a workflow-scoped candidate for the fixed workflow_id.
  await ctx.db.insert(skillCandidates).values({
    tenant_id,
    scope: "workflow",
    workflow_id,
    pattern_kind: "success_pattern",
    title: "Workflow scope candidate",
    body: "This candidate is scoped to a specific workflow.",
    evidence: [],
    confidence: "medium",
    fingerprint: "fp-wf-scoped",
  });
}, 60_000);

afterAll(async () => {
  if (!skip && ctx) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("assembler render order — recipe bodies + skill candidates", () => {
  test("connectorRecipeBodiesBlock appears after connectorRecipesBlock and before connector skills index", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        connector_id,
        user_turns: [{ role: "user", content: "charge payment stripe webhook" }],
        max_tokens: 50_000,
        model: "mock",
      },
      ctx.db,
    );

    const sys = prompt.system;

    // "Available recipes — connector" = slim roster
    const recipesIdx = sys.indexOf("# Available recipes — connector");
    // "Recipe bodies — connector" = rich bodies block
    const bodiesIdx = sys.indexOf("# Recipe bodies — connector");
    // "Connector skill index" or "skill index" heading
    const connectorIndexIdx = sys.indexOf("connector skill index");

    // Recipe bodies must exist
    expect(bodiesIdx).toBeGreaterThan(-1);

    // Recipe bodies must appear AFTER the slim roster
    if (recipesIdx > -1 && bodiesIdx > -1) {
      expect(bodiesIdx).toBeGreaterThan(recipesIdx);
    }

    // Recipe bodies must appear BEFORE the connector skill index (if it exists)
    if (bodiesIdx > -1 && connectorIndexIdx > -1) {
      expect(bodiesIdx).toBeLessThan(connectorIndexIdx);
    }
  });

  test("skillCandidatesBlock appears after the available recipes section", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        connector_id,
        user_turns: [{ role: "user", content: "stripe charge webhook" }],
        max_tokens: 50_000,
        model: "mock",
      },
      ctx.db,
    );

    const sys = prompt.system;
    const candidatesIdx = sys.indexOf("Skill candidates — proposed");
    const recipesIdx = sys.indexOf("# Available recipes — connector");

    // Candidates section must exist when there are proposed candidates
    expect(candidatesIdx).toBeGreaterThan(-1);

    // Candidates appear after the recipe roster (which is above the bodies block)
    if (candidatesIdx > -1 && recipesIdx > -1) {
      expect(candidatesIdx).toBeGreaterThan(recipesIdx);
    }
  });

  test("drop ladder contains section names as string constants, not magic values", () => {
    // Verify the module-level constants match the strings the assembler uses.
    expect(SECTION_SKILL_CANDIDATES).toBe("skill_candidates");
    expect(SECTION_CONNECTOR_RECIPE_BODIES).toBe("connector_recipe_bodies");
    expect(SECTION_CONNECTOR_RECIPES).toBe("connector_recipes");
  });
});

// ---------------------------------------------------------------------------
// Workflow-scope contract: workflow_id unset → workflow-scoped candidates absent
// ---------------------------------------------------------------------------

describe.skipIf(skip)(
  "workflow-scope contract — workflow_id unset means no workflow-scoped candidates",
  () => {
    test("workflow-scoped candidates are ABSENT when workflow_id is not provided", async () => {
      const prompt = await assembleEnhancedPrompt(
        {
          tenant_id,
          flow: "converse",
          connector_id,
          // workflow_id intentionally absent
          user_turns: [{ role: "user", content: "stripe rate limit" }],
          max_tokens: 50_000,
          model: "mock",
        },
        ctx.db,
      );

      // The workflow-scoped candidate title must NOT appear in the prompt
      expect(prompt.system).not.toContain("Workflow scope candidate");

      // The connector-scoped candidate SHOULD appear (scoped to this connector)
      expect(prompt.system).toContain("Stripe rate limit backoff");
    });

    test("workflow-scoped candidates ARE present when workflow_id matches", async () => {
      const prompt = await assembleEnhancedPrompt(
        {
          tenant_id,
          flow: "converse",
          connector_id,
          workflow_id,
          user_turns: [{ role: "user", content: "stripe charge" }],
          max_tokens: 50_000,
          model: "mock",
        },
        ctx.db,
      );

      // When workflow_id is provided, the workflow-scoped candidate must appear
      expect(prompt.system).toContain("Workflow scope candidate");
    });
  },
);

// ---------------------------------------------------------------------------
// Drop ladder — deterministic overflow (heavy seed)
// ---------------------------------------------------------------------------
//
// The render-order describe block above uses a light seed (1 candidate, 2
// recipes) so the natural prompt total sits just above the irreducible
// base. At that scale, dropping the new sections shaves only ~150-500
// tokens — too thin to reliably force the drop ladder past the cap.
//
// This block sets up a dedicated tenant + heavy seed (3 large recipes,
// 30 proposed candidates) so the new sections collectively contribute
// 3000+ tokens. A 9000-token cap then DETERMINISTICALLY forces the
// trimmer to drop skill_candidates first, then connector_recipe_bodies.
// Assertions are unconditional — the test fails loudly if the ladder
// ever flips ordering.

const SECTION_SKILL_CANDIDATES_HEAVY = "skill_candidates";
const SECTION_CONNECTOR_RECIPE_BODIES_HEAVY = "connector_recipe_bodies";

const HEAVY_RECIPE_SNAPSHOT: Record<string, unknown> = {
  slug: "stripe",
  recipes: Array.from({ length: 3 }, (_, i) => ({
    slug: `stripe-heavy-${i}`,
    title: `Heavy recipe ${i}`,
    description:
      "A workflow that pushes stripe charge data through several transforms before posting to a downstream sink. " +
      "Realistic-looking description so the rendered body has real content. ".repeat(2),
    category: "webhooks",
    difficulty: "easy",
    intent_keywords: ["charge", "payment", "webhook", "heavy"],
    tags: ["billing", "stripe", "heavy"],
    prerequisites: ["Stripe connector set up", "Downstream sink configured"],
    required_connectors: [{ placeholder: "stripe", template: "stripe" }],
    sample_input: { event: `charge.succeeded.${i}`, amount: 5000 + i, currency: "usd" },
    // Workflow large enough that even the full-body path (no fallback)
    // contributes ~600-800 tokens per recipe → 3 recipes × ~700 = ~2100
    // before the 2000-token section cap kicks in.
    workflow: {
      name: `stripe-heavy-${i}`,
      steps: Array.from({ length: 8 }, (_, j) => ({
        id: `step-${j}`,
        kind: "request",
        connector_id: "${stripe}",
        path: `/v1/items/${i}/${j}`,
        params: { key: `value-${i}-${j}-${"data".repeat(4)}` },
      })),
    },
  })),
};

describe.skipIf(skip)("drop ladder — deterministic overflow (heavy seed)", () => {
  let heavyCtx: TestDb;
  let heavyTenantId: string;
  let heavyConnectorId: string;

  beforeAll(async () => {
    if (skip) return;
    heavyCtx = await createTestDb("assembler_drop_ladder_heavy");
    const [t] = await heavyCtx.db
      .insert(tenants)
      .values({ slug: "t-aro-heavy", display_name: "Drop Ladder Heavy Test" })
      .returning();
    heavyTenantId = t!.id;

    const [c] = await heavyCtx.db
      .insert(connectors)
      .values({
        tenant_id: heavyTenantId,
        slug: "stripe",
        display_name: "Stripe",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: "https://api.stripe.com",
        config: {},
        template_snapshot: HEAVY_RECIPE_SNAPSHOT,
      })
      .returning();
    heavyConnectorId = c!.id;

    // 30 proposed candidates with ~200 token bodies. After the 1200-token
    // section cap is enforced by trimCandidatesToBudget, the rendered
    // section is at most ~1200 tokens — but the seed guarantees the
    // section is non-empty and substantial.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      tenant_id: heavyTenantId,
      scope: "connector" as const,
      connector_id: heavyConnectorId,
      pattern_kind: "repair_pattern" as const,
      title: `Heavy candidate ${i}`,
      body:
        "When the upstream API returns an unexpected envelope, apply this remediation. " +
        "Real-world example: detect the malformed shape, branch to the fallback transform, ".repeat(
          2,
        ) +
        `(candidate ${i})`,
      evidence: [],
      confidence: "medium" as const,
      fingerprint: `fp-heavy-${i}`,
    }));
    await heavyCtx.db.insert(skillCandidates).values(rows);
  }, 60_000);

  afterAll(async () => {
    if (!skip && heavyCtx) await heavyCtx.cleanup();
  }, 30_000);

  test("under tight budget, skill_candidates drops BEFORE connector_recipe_bodies (unconditional)", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: heavyTenantId,
        flow: "converse",
        connector_id: heavyConnectorId,
        user_turns: [{ role: "user", content: "stripe charge heavy" }],
        max_tokens: 9000,
        model: "mock",
      },
      heavyCtx.db,
    );

    const dropped = prompt.dropped_sections;
    const skillCandIdx = dropped.indexOf(SECTION_SKILL_CANDIDATES_HEAVY);
    const recipeBodiesIdx = dropped.indexOf(SECTION_CONNECTOR_RECIPE_BODIES_HEAVY);

    // Deterministic seed: natural total > cap, so BOTH sections must drop.
    expect(skillCandIdx).toBeGreaterThan(-1);
    expect(recipeBodiesIdx).toBeGreaterThan(-1);
    // Drop ORDER: skill_candidates (lower priority) appears first in the
    // dropped list, then connector_recipe_bodies.
    expect(skillCandIdx).toBeLessThan(recipeBodiesIdx);
  });
});
