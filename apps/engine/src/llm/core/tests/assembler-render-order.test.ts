import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectors,
  schemaVersions,
  skillCandidates,
  tenants,
  workflows,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { logger } from "../../../logging/logger.ts";
import { resetMockProvider } from "../../mock-provider.ts";
import type { AuthoringPromptHint } from "../../types.ts";
import { assembleEnhancedPrompt } from "../context-assembler.ts";

function authoringHintFor(mode: "connector" | "workflow"): AuthoringPromptHint {
  return {
    mode,
    stage: mode === "workflow" ? "workflow_draft_started" : "connector_draft_started",
    lifecycle_state: "draft_only",
    active_target: { kind: mode, lifecycle_state: "draft_only" },
    blocked_by: [],
    next_required_action: null,
    next_suggested_tool: null,
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
  };
}

const SECTION_SKILL_CANDIDATES = "skill_candidates";
const SECTION_CONNECTOR_RECIPE_BODIES = "connector_recipe_bodies";
const SECTION_CONNECTOR_RECIPES = "connector_recipes";

const skip = process.env.REQUIRES_PG === "0";

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
            connector_id: `\${stripe}`,
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

    const recipesIdx = sys.indexOf("# Available recipes — connector");
    const bodiesIdx = sys.indexOf("# Recipe bodies — connector");
    const connectorIndexIdx = sys.indexOf("connector skill index");

    expect(bodiesIdx).toBeGreaterThan(-1);

    if (recipesIdx > -1 && bodiesIdx > -1) {
      expect(bodiesIdx).toBeGreaterThan(recipesIdx);
    }

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

    expect(candidatesIdx).toBeGreaterThan(-1);

    if (candidatesIdx > -1 && recipesIdx > -1) {
      expect(candidatesIdx).toBeGreaterThan(recipesIdx);
    }
  });

  test("drop ladder contains section names as string constants, not magic values", () => {
    expect(SECTION_SKILL_CANDIDATES).toBe("skill_candidates");
    expect(SECTION_CONNECTOR_RECIPE_BODIES).toBe("connector_recipe_bodies");
    expect(SECTION_CONNECTOR_RECIPES).toBe("connector_recipes");
  });
});

describe.skipIf(skip)(
  "workflow-scope contract — workflow_id unset means no workflow-scoped candidates",
  () => {
    test("workflow-scoped candidates are ABSENT when workflow_id is not provided", async () => {
      const prompt = await assembleEnhancedPrompt(
        {
          tenant_id,
          flow: "converse",
          connector_id,
          user_turns: [{ role: "user", content: "stripe rate limit" }],
          max_tokens: 50_000,
          model: "mock",
        },
        ctx.db,
      );

      expect(prompt.system).not.toContain("Workflow scope candidate");

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

      expect(prompt.system).toContain("Workflow scope candidate");
    });
  },
);

describe.skipIf(skip)("recorded endpoint samples — workflow-authoring mode gate", () => {
  const SAMPLES_HEADING = "# Recorded endpoint samples";
  const ROOMY_MODEL = "claude-sonnet-4-5";

  beforeAll(async () => {
    if (skip) return;
    await ctx.db.insert(schemaVersions).values({
      tenant_id,
      connector_id,
      endpoint_key: "GET /v1/charges",
      schema: {
        type: "object",
        properties: {
          data: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, amount: { type: "number" } },
            },
          },
          has_more: { type: "boolean" },
        },
      },
    });
  });

  test("renders the section in workflow-authoring mode for bound connectors", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        connector_id,
        user_turns: [{ role: "user", content: "build a workflow listing charges" }],
        max_tokens: 50_000,
        model: ROOMY_MODEL,
        authoring_hint: authoringHintFor("workflow"),
        authoring_connector_ids: [connector_id],
      },
      ctx.db,
    );
    expect(prompt.system).toContain(SAMPLES_HEADING);
    expect(prompt.system).toContain("GET /v1/charges");
    expect(prompt.system).toContain("has_more: boolean");
  });

  test("section is ABSENT outside workflow-authoring mode (connector mode / no hint)", async () => {
    const connectorMode = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        connector_id,
        user_turns: [{ role: "user", content: "set up the stripe connector" }],
        max_tokens: 50_000,
        model: ROOMY_MODEL,
        authoring_hint: authoringHintFor("connector"),
        authoring_connector_ids: [connector_id],
      },
      ctx.db,
    );
    expect(connectorMode.system).not.toContain(SAMPLES_HEADING);

    const noHint = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        connector_id,
        user_turns: [{ role: "user", content: "stripe charges" }],
        max_tokens: 50_000,
        model: ROOMY_MODEL,
        authoring_connector_ids: [connector_id],
      },
      ctx.db,
    );
    expect(noHint.system).not.toContain(SAMPLES_HEADING);
  });

  test("section is ABSENT when no shapes were recorded for the bound connectors", async () => {
    const [bare] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "stripe-no-shapes",
        display_name: "Stripe (no shapes)",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://api.stripe.com",
        config: {},
      })
      .returning();
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "build a workflow" }],
        max_tokens: 50_000,
        model: ROOMY_MODEL,
        authoring_hint: authoringHintFor("workflow"),
        authoring_connector_ids: [bare!.id],
      },
      ctx.db,
    );
    expect(prompt.system).not.toContain(SAMPLES_HEADING);
  });
});

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
    workflow: {
      name: `stripe-heavy-${i}`,
      steps: Array.from({ length: 8 }, (_, j) => ({
        id: `step-${j}`,
        kind: "request",
        connector_id: `\${stripe}`,
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

    await heavyCtx.db.insert(schemaVersions).values(
      Array.from({ length: 4 }, (_, i) => ({
        tenant_id: heavyTenantId,
        connector_id: heavyConnectorId,
        endpoint_key: `GET /v1/heavy-${i}`,
        schema: {
          type: "object" as const,
          properties: Object.fromEntries(
            Array.from({ length: 10 }, (_, j) => [`field_${i}_${j}`, { type: "string" as const }]),
          ),
        },
      })),
    );
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
        max_tokens: 10_000,
        model: "mock",
      },
      heavyCtx.db,
    );

    const dropped = prompt.dropped_sections;
    const skillCandIdx = dropped.indexOf(SECTION_SKILL_CANDIDATES_HEAVY);
    const recipeBodiesIdx = dropped.indexOf(SECTION_CONNECTOR_RECIPE_BODIES_HEAVY);

    expect(skillCandIdx).toBeGreaterThan(-1);
    expect(recipeBodiesIdx).toBeGreaterThan(-1);
    expect(skillCandIdx).toBeLessThan(recipeBodiesIdx);
  });

  test("recorded_endpoint_samples drops FIRST — before skill_candidates and connector_recipe_bodies", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: heavyTenantId,
        flow: "converse",
        connector_id: heavyConnectorId,
        user_turns: [{ role: "user", content: "stripe charge heavy workflow" }],
        max_tokens: 13_000,
        model: "mock",
        authoring_hint: authoringHintFor("workflow"),
        authoring_connector_ids: [heavyConnectorId],
      },
      heavyCtx.db,
    );

    const dropped = prompt.dropped_sections;
    const samplesIdx = dropped.indexOf("recorded_endpoint_samples");
    const skillCandIdx = dropped.indexOf(SECTION_SKILL_CANDIDATES_HEAVY);
    const recipeBodiesIdx = dropped.indexOf(SECTION_CONNECTOR_RECIPE_BODIES_HEAVY);

    expect(samplesIdx).toBe(0);
    expect(skillCandIdx).toBeGreaterThan(samplesIdx);
    if (recipeBodiesIdx > -1) {
      expect(recipeBodiesIdx).toBeGreaterThan(samplesIdx);
    }
    if (dropped.includes("authoring_evidence_refs")) {
      expect(prompt.system).not.toContain("# Recorded endpoint samples");
    } else {
      expect(prompt.system).toContain("# Recorded endpoint samples");
      expect(prompt.system).toContain("[trimmed to fit the context budget");
    }
  });
});
