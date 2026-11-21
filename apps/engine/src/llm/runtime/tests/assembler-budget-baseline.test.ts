import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectors, skillCandidates } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { logger } from "../../../logging/index.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { contextCapFor } from "../../accounting/index.ts";
import { resetMockProvider } from "../../mock-provider.ts";
import { assembleEnhancedPrompt } from "../context-assembler.ts";

interface FixtureExpectedOutcome {
  kind:
    | "recipe-backed"
    | "multi-connector-recipe"
    | "drift-context"
    | "cold-start"
    | "edit-existing-workflow";
  required_in_prompt?: string[];
  candidate_title?: string;
}

interface FixtureItem {
  name: string;
  kind: FixtureExpectedOutcome["kind"];
  params: {
    flow: string;
    user_turns: Array<{ role: string; content: string }>;
    max_tokens: number;
    model: string;
    connector_slug?: string;
    workflow_id?: string;
    candidate_title?: string;
    candidate_scope?: string;
  };
  expected_outcome: FixtureExpectedOutcome;
  total_tokens: number;
  section_tokens: Record<string, number>;
}

interface BaselineFixture {
  captured_at: string;
  worktree_sha: string;
  captured_by_script_version: string;
  model: string;
  effective_cap: number;
  fixtures: FixtureItem[];
}

const BASELINE_PATH = join(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "__fixtures__",
  "budget-baseline.json",
);

function loadBaseline(): BaselineFixture {
  try {
    const raw = readFileSync(BASELINE_PATH, "utf-8");
    return JSON.parse(raw) as BaselineFixture;
  } catch (err) {
    throw new Error(
      `Budget baseline fixture not found at ${BASELINE_PATH}. ` +
        `The fixture is committed; restore it from version control.\n${String(err)}`,
    );
  }
}

const skip = testEnv.REQUIRES_PG === "0";

if (skip) {
  logger.warn({
    module: "test",
    action: "test.suite.skipped",
    msg: "REQUIRES_PG=0 — skipping G1-G4 budget regression guards. Run with Postgres to re-enable.",
    suite: "assembler-budget-baseline",
  });
}

let ctx: TestDb;
let tenant_id: string;
const connectorIdBySlug = new Map<string, string>();

let baseline: BaselineFixture;

beforeAll(async () => {
  if (skip) return;

  baseline = loadBaseline();

  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();

  ctx = await createTestDb("assembler_budget_baseline");
  const t = await seedTenant(ctx.db, { slug: "t-budget", display_name: "Budget Baseline Test" });
  tenant_id = t.id;

  const stripeSnapshot: Record<string, unknown> = {
    slug: "stripe",
    recipes: [
      {
        slug: "stripe-charge-succeeded",
        title: "Handle Stripe charge succeeded",
        description: "Fires when a Stripe charge.succeeded webhook arrives.",
        category: "webhooks",
        difficulty: "easy",
        intent_keywords: ["charge", "payment", "webhook", "succeeded"],
        tags: ["billing", "stripe"],
        prerequisites: ["Stripe connector configured"],
        required_connectors: [{ placeholder: "stripe", template: "stripe" }],
        sample_input: { event: "charge.succeeded", amount: 5000 },
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
        slug: "stripe-customer-sync",
        title: "Sync Stripe customer to CRM",
        description: "Syncs a new Stripe customer to the CRM on creation.",
        category: "sync",
        difficulty: "intermediate",
        intent_keywords: ["customer", "sync", "crm", "stripe"],
        tags: ["crm", "stripe"],
        prerequisites: ["Stripe connector", "CRM connector"],
        required_connectors: [
          { placeholder: "stripe", template: "stripe" },
          { placeholder: "hubspot", template: "hubspot" },
        ],
        sample_input: { customer_id: "cus_abc123" },
        workflow: {
          name: "stripe-customer-sync",
          steps: [
            {
              id: "fetch",
              kind: "request",
              connector_id: `\${stripe}`,
              path: `/v1/customers/\${input.customer_id}`,
              params: {},
            },
            {
              id: "sync",
              kind: "request",
              connector_id: `\${hubspot}`,
              path: "/crm/v3/contacts",
              params: { email: `\${scope.fetch.email}` },
            },
          ],
        },
      },
    ],
  };

  const [stripeConn] = await ctx.db
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
      template_snapshot: stripeSnapshot,
    })
    .returning();
  connectorIdBySlug.set("stripe", stripeConn!.id);

  await ctx.db.insert(skillCandidates).values({
    tenant_id,
    scope: "global",
    pattern_kind: "repair_pattern",
    title: "Stripe 429 exponential backoff",
    body: "When Stripe returns HTTP 429, implement exponential backoff starting at 1s doubling each retry, max 5 retries.",
    evidence: [],
    confidence: "high",
    fingerprint: "fp-baseline-stripe-429",
  });
}, 60_000);

afterAll(async () => {
  if (!skip && ctx) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("budget-baseline — four guards", () => {
  const fixtureResults: Array<{
    name: string;
    kind: FixtureExpectedOutcome["kind"];
    baseline_total: number;
    new_total: number;
    system: string;
    expected_outcome: FixtureExpectedOutcome;
    params: FixtureItem["params"];
  }> = [];

  beforeAll(async () => {
    if (skip || !baseline) return;

    for (const fixture of baseline.fixtures) {
      const connector_id = fixture.params.connector_slug
        ? connectorIdBySlug.get(fixture.params.connector_slug)
        : undefined;

      const prompt = await assembleEnhancedPrompt(
        {
          tenant_id,
          flow: fixture.params.flow as "converse" | "generate",
          user_turns: fixture.params.user_turns as Array<{
            role: "user" | "assistant" | "system";
            content: string;
          }>,
          max_tokens: fixture.params.max_tokens,
          model: fixture.params.model,
          ...(connector_id ? { connector_id } : {}),
          ...(fixture.params.workflow_id ? { workflow_id: fixture.params.workflow_id } : {}),
        },
        ctx.db,
      );

      fixtureResults.push({
        name: fixture.name,
        kind: fixture.kind,
        baseline_total: fixture.total_tokens,
        new_total: prompt.token_counts.total,
        system: prompt.system,
        expected_outcome: fixture.expected_outcome,
        params: fixture.params,
      });
    }
  }, 120_000);

  test("G1: per-fixture cost regression — new_total ≤ baseline × 1.15", () => {
    expect(fixtureResults.length).toBeGreaterThan(0);
    for (const r of fixtureResults) {
      const limit = Math.ceil(r.baseline_total * 1.15);
      expect(r.new_total, `${r.name}: ${r.new_total} tokens exceeds ${limit}`).toBeLessThanOrEqual(
        limit,
      );
    }
  });

  test("G2: absolute ceiling — max(total_tokens) ≤ contextCapFor(model) × 0.85", () => {
    expect(fixtureResults.length).toBeGreaterThan(0);
    const model = baseline.model;
    const cap = contextCapFor(model);
    const ceiling = Math.floor(cap * 0.85);
    for (const r of fixtureResults) {
      expect(r.new_total).toBeLessThanOrEqual(ceiling);
    }
  });

  test("G3: aggregate cost — Σ new_total ≤ Σ baseline × 1.15", () => {
    expect(fixtureResults.length).toBeGreaterThan(0);
    const sumBaseline = fixtureResults.reduce((acc, r) => acc + r.baseline_total, 0);
    const sumNew = fixtureResults.reduce((acc, r) => acc + r.new_total, 0);
    expect(sumNew).toBeLessThanOrEqual(Math.ceil(sumBaseline * 1.15));
  });

  test("G4: outcome substrate — recipe-backed fixtures contain slug + workflow JSON fence", () => {
    const recipeBacked = fixtureResults.filter(
      (r) =>
        r.expected_outcome.kind === "recipe-backed" ||
        r.expected_outcome.kind === "multi-connector-recipe",
    );
    for (const r of recipeBacked) {
      const required = r.expected_outcome.required_in_prompt ?? [];
      for (const token of required) {
        expect(r.system).toContain(token);
      }
    }
  });

  test("G4: drift-context fixtures keep the seeded proposed candidate out of the prompt", () => {
    const driftContext = fixtureResults.filter((r) => r.expected_outcome.kind === "drift-context");
    for (const r of driftContext) {
      const title = r.expected_outcome.candidate_title;
      if (title) {
        expect(r.system).not.toContain(title);
      }
    }
  });

  test("baseline fixture has the required header fields", () => {
    expect(baseline.captured_at).toBeTruthy();
    expect(baseline.worktree_sha).toBe("5a0bae7606b846734f30a32d37204ff26c8ea485");
    expect(baseline.captured_by_script_version).toBe("1.0.0");
    expect(baseline.model).toBe("claude-haiku-4-5");
    expect(baseline.effective_cap).toBeGreaterThan(0);
    expect(baseline.fixtures).toHaveLength(10);
  });

  test("all 10 fixtures ran successfully", () => {
    expect(fixtureResults).toHaveLength(10);
  });
});
