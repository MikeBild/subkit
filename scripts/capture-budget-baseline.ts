#!/usr/bin/env bun
/**
 * capture-budget-baseline.ts — one-shot baseline capture for the assembler
 * budget regression + benchmark substrate test.
 *
 * THIS FILE IS A ONE-TIME ARTIFACT. Do not regenerate unless an explicit
 * `regen/budget-baseline` change documents why. Never wired into
 * package.json scripts. Never runs in CI.
 *
 * Run protocol (per plan §5 decision 5 + R5 mitigation):
 *
 *   git worktree add /tmp/sk-baseline-worktree bae45172
 *   cp scripts/capture-budget-baseline.ts /tmp/sk-baseline-worktree/scripts/
 *   cd /tmp/sk-baseline-worktree
 *   bun scripts/capture-budget-baseline.ts --regen=initial-pre-bundle --force
 *   cp apps/engine/src/llm/core/tests/__fixtures__/budget-baseline.json \
 *      /<feature-branch>/apps/engine/src/llm/core/tests/__fixtures__/
 *   git worktree remove /tmp/sk-baseline-worktree --force
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connectors, skillCandidates, tenants } from "../apps/engine/src/db/schema/index.ts";
import { createTestDb } from "../apps/engine/src/db/tests/setup.ts";
import { contextCapFor } from "../apps/engine/src/llm/accounting/index.ts";
import { assembleEnhancedPrompt } from "../apps/engine/src/llm/core/context-assembler.ts";
import { resetMockProvider } from "../apps/engine/src/llm/mock-provider.ts";

// ---------------------------------------------------------------------------
// Hard-pinned values — the test asserts these exactly.
// ---------------------------------------------------------------------------

const SCRIPT_VERSION = "1.0.0";
const PRE_BUNDLE_SHA = "bae451724cbea5aaaad3645b445c620fb9fbdaca";
const MODEL = "claude-haiku-4-5";
const FIXTURE_PATH = "apps/engine/src/llm/core/tests/__fixtures__/budget-baseline.json";

// ---------------------------------------------------------------------------
// Fixture definitions — 10 total: 2× per category.
// `connector_slug` resolves to a real connector id at runtime.
// ---------------------------------------------------------------------------

interface FixtureDef {
  name: string;
  kind:
    | "recipe-backed"
    | "multi-connector-recipe"
    | "drift-context"
    | "cold-start"
    | "edit-existing-workflow";
  params: {
    flow: "converse";
    user_turns: Array<{ role: "user"; content: string }>;
    max_tokens: number;
    model: string;
    connector_slug?: string;
    workflow_id?: string;
  };
  expected_outcome: {
    kind: FixtureDef["kind"];
    required_in_prompt?: string[];
    candidate_title?: string;
  };
}

const fixtures: FixtureDef[] = [
  {
    name: "recipe-backed-stripe-charge",
    kind: "recipe-backed",
    params: {
      flow: "converse",
      user_turns: [
        {
          role: "user",
          content: "Build me a workflow that handles Stripe charge.succeeded webhooks.",
        },
      ],
      max_tokens: 100_000,
      model: MODEL,
      connector_slug: "stripe",
    },
    expected_outcome: {
      kind: "recipe-backed",
      required_in_prompt: ["stripe-charge-succeeded", "```json"],
    },
  },
  {
    name: "recipe-backed-stripe-customer-sync",
    kind: "recipe-backed",
    params: {
      flow: "converse",
      user_turns: [{ role: "user", content: "Sync new Stripe customers into our CRM." }],
      max_tokens: 100_000,
      model: MODEL,
      connector_slug: "stripe",
    },
    expected_outcome: {
      kind: "recipe-backed",
      required_in_prompt: ["stripe-customer-sync", "```json"],
    },
  },
  {
    name: "multi-connector-stripe-hubspot",
    kind: "multi-connector-recipe",
    params: {
      flow: "converse",
      user_turns: [
        {
          role: "user",
          content: "When a Stripe customer is created, push them to HubSpot as a contact.",
        },
      ],
      max_tokens: 100_000,
      model: MODEL,
      connector_slug: "stripe",
    },
    expected_outcome: {
      kind: "multi-connector-recipe",
      required_in_prompt: ["stripe-customer-sync", "hubspot", "```json"],
    },
  },
  {
    name: "multi-connector-customer-crm-sync",
    kind: "multi-connector-recipe",
    params: {
      flow: "converse",
      user_turns: [
        { role: "user", content: "Wire up customer sync from Stripe to my CRM with HubSpot." },
      ],
      max_tokens: 100_000,
      model: MODEL,
      connector_slug: "stripe",
    },
    expected_outcome: {
      kind: "multi-connector-recipe",
      required_in_prompt: ["stripe-customer-sync", "hubspot", "```json"],
    },
  },
  {
    name: "drift-context-stripe-429",
    kind: "drift-context",
    params: {
      flow: "converse",
      user_turns: [
        {
          role: "user",
          content: "Add retry handling to my Stripe workflow — it keeps hitting rate limits.",
        },
      ],
      max_tokens: 100_000,
      model: MODEL,
      connector_slug: "stripe",
    },
    expected_outcome: {
      kind: "drift-context",
      candidate_title: "Stripe 429 exponential backoff",
    },
  },
  {
    name: "drift-context-cold-stripe-author",
    kind: "drift-context",
    params: {
      flow: "converse",
      user_turns: [
        {
          role: "user",
          content: "Build me a Stripe webhook handler — and make sure rate limits are handled.",
        },
      ],
      max_tokens: 100_000,
      model: MODEL,
      connector_slug: "stripe",
    },
    expected_outcome: {
      kind: "drift-context",
      candidate_title: "Stripe 429 exponential backoff",
    },
  },
  {
    name: "cold-start-no-context",
    kind: "cold-start",
    params: {
      flow: "converse",
      user_turns: [{ role: "user", content: "What can you help me build?" }],
      max_tokens: 100_000,
      model: MODEL,
    },
    expected_outcome: { kind: "cold-start" },
  },
  {
    name: "cold-start-vague-intent",
    kind: "cold-start",
    params: {
      flow: "converse",
      user_turns: [{ role: "user", content: "I want to automate something for my business." }],
      max_tokens: 100_000,
      model: MODEL,
    },
    expected_outcome: { kind: "cold-start" },
  },
  {
    name: "edit-existing-workflow-stripe",
    kind: "edit-existing-workflow",
    params: {
      flow: "converse",
      user_turns: [
        { role: "user", content: "Update the Stripe workflow to also log to our audit channel." },
      ],
      max_tokens: 100_000,
      model: MODEL,
      connector_slug: "stripe",
      workflow_id: "00000000-0000-0000-0000-000000000001",
    },
    expected_outcome: { kind: "edit-existing-workflow" },
  },
  {
    name: "edit-existing-workflow-no-connector",
    kind: "edit-existing-workflow",
    params: {
      flow: "converse",
      user_turns: [
        { role: "user", content: "Modify my existing workflow to retry on transient errors." },
      ],
      max_tokens: 100_000,
      model: MODEL,
      workflow_id: "00000000-0000-0000-0000-000000000002",
    },
    expected_outcome: { kind: "edit-existing-workflow" },
  },
];

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function parseFlags(): { regen: string | null; force: boolean } {
  const args = process.argv.slice(2);
  let regen: string | null = null;
  let force = false;
  for (const arg of args) {
    if (arg.startsWith("--regen=")) regen = arg.slice("--regen=".length);
    else if (arg === "--force") force = true;
  }
  return { regen, force };
}

function abort(msg: string): never {
  process.stderr.write(`capture-budget-baseline: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Seed helpers — mirror the test's beforeAll seeding shape
// ---------------------------------------------------------------------------

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
            connector_id: "${stripe}",
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
            connector_id: "${stripe}",
            path: "/v1/customers/${input.customer_id}",
            params: {},
          },
          {
            id: "sync",
            kind: "request",
            connector_id: "${hubspot}",
            path: "/crm/v3/contacts",
            params: { email: "${scope.fetch.email}" },
          },
        ],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { regen, force } = parseFlags();
  if (!regen) {
    abort("missing required flag: --regen=<reason-slug>");
  }
  process.stderr.write(`capture-budget-baseline: regen reason = "${regen}"\n`);

  if (existsSync(FIXTURE_PATH) && !force) {
    let existingHeader = "";
    try {
      const existing = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
      existingHeader = `  captured_at: ${existing.captured_at}\n  worktree_sha: ${existing.worktree_sha}\n  captured_by_script_version: ${existing.captured_by_script_version}`;
    } catch {}
    abort(
      `refusing to overwrite existing baseline at ${FIXTURE_PATH}\n${existingHeader}\nPass --force to regenerate.`,
    );
  }
  if (existsSync(FIXTURE_PATH) && force) {
    process.stderr.write(`capture-budget-baseline: --force given, overwriting existing baseline\n`);
  }

  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();

  const ctx = await createTestDb("capture_budget_baseline");

  try {
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-baseline", display_name: "Baseline Capture" })
      .returning();
    const tenant_id = t!.id;

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
    const connectorIdBySlug = new Map<string, string>([["stripe", stripeConn!.id]]);

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

    const captured: Array<Record<string, unknown>> = [];
    for (const fixture of fixtures) {
      const connector_id = fixture.params.connector_slug
        ? connectorIdBySlug.get(fixture.params.connector_slug)
        : undefined;

      const prompt = await assembleEnhancedPrompt(
        {
          tenant_id,
          flow: fixture.params.flow,
          user_turns: fixture.params.user_turns,
          max_tokens: fixture.params.max_tokens,
          model: fixture.params.model,
          ...(connector_id ? { connector_id } : {}),
          ...(fixture.params.workflow_id ? { workflow_id: fixture.params.workflow_id } : {}),
        },
        ctx.db,
      );

      captured.push({
        name: fixture.name,
        kind: fixture.kind,
        params: fixture.params,
        expected_outcome: fixture.expected_outcome,
        total_tokens: prompt.token_counts.total,
        section_tokens: prompt.token_counts,
      });
      process.stderr.write(`  ✓ ${fixture.name}: ${prompt.token_counts.total} tokens\n`);
    }

    const output = {
      captured_at: new Date().toISOString(),
      worktree_sha: PRE_BUNDLE_SHA,
      captured_by_script_version: SCRIPT_VERSION,
      model: MODEL,
      effective_cap: contextCapFor(MODEL),
      fixtures: captured,
    };

    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
    process.stderr.write(
      `\ncapture-budget-baseline: wrote ${FIXTURE_PATH} (${captured.length} fixtures)\n`,
    );
  } finally {
    await ctx.cleanup();
  }
}

main().catch((err) => {
  process.stderr.write(`capture-budget-baseline: FAILED\n${err.stack ?? err}\n`);
  process.exit(1);
});
