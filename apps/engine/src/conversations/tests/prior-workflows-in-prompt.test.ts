import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { assembleEnhancedPrompt } from "../../llm/runtime/context-assembler.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createSeededRandom } from "../../test-helpers/determinism/random.ts";
import { createWorkflow } from "../../workflows/service.ts";

const stripeConnectorId = "00000000-0000-4000-8000-000000000010";
const hubspotConnectorId = "00000000-0000-4000-8000-000000000020";

let ctx: TestDb;
const rng = createSeededRandom(0xc0_03_5e_ed);

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();
  ctx = await createTestDb("prior_workflows_in_prompt");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function newTenant(label: string): Promise<string> {
  const suffix = rng.bytes(4).reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${label}-${suffix}`, display_name: label })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  return t.id;
}

async function seedWorkflow(tenant_id: string, def: Record<string, unknown>): Promise<void> {
  const r = await createWorkflow({ tenant_id, def, actor_id: null }, ctx.db);
  if ("errors" in r) throw new Error(`seed failed: ${r.errors.join("; ")}`);
}

describe("Prior workflows · 5th authoring context source", () => {
  test("structured authoring flow surfaces the matching active workflow as a reference case", async () => {
    const tenant_id = await newTenant("hit");

    await seedWorkflow(tenant_id, {
      name: "Stripe webhook → Slack ops",
      slug: "wf-stripe-slack-ops",
      description: "Notify #ops when a Stripe charge succeeds.",
      trigger: {
        kind: "webhook",
        source: "stripe",
        events: ["charge.succeeded"],
        verify: "stripe-signature",
      },
      steps: [
        {
          id: "ingest",
          kind: "request",
          method: "POST",
          url: "https://api.stripe.com/v1/events",
          connector_id: stripeConnectorId,
        },
        {
          id: "post",
          kind: "request",
          method: "POST",
          url: "https://slack.com/api/chat.postMessage",
        },
      ],
    });
    await seedWorkflow(tenant_id, {
      name: "HubSpot contacts sync",
      slug: "wf-hubspot-sync",
      description: "Mirror contacts from HubSpot to the data warehouse.",
      steps: [
        {
          id: "list",
          kind: "request",
          method: "GET",
          url: "https://api.hubspot.com/crm/v3/objects/contacts",
          connector_id: hubspotConnectorId,
        },
      ],
    });

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "generate",
        connector_id: stripeConnectorId,
        user_turns: [{ role: "user", content: "send Slack when Stripe charge succeeds" }],
        max_tokens: 180_000,
        model: "claude-sonnet-4-6",
      },
      ctx.db,
    );

    expect(prompt.system).toContain("### Prior workflows [reference, not template]");
    expect(prompt.system).toContain("wf-stripe-slack-ops");
    expect(prompt.system).toContain("[reference, not template]");
    expect(prompt.system).toContain("webhook (stripe)");
    expect(prompt.system).toContain("1. request");

    expect(prompt.included_prior_workflow_slugs[0]).toBe("wf-stripe-slack-ops");

    expect(prompt.token_counts.prior_workflows).toBeGreaterThan(0);
  });

  test("tenant with no similar workflows omits the section cleanly", async () => {
    const tenant_id = await newTenant("miss");

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "generate",
        connector_id: stripeConnectorId,
        user_turns: [{ role: "user", content: "send Slack when Stripe charge succeeds" }],
        max_tokens: 180_000,
        model: "claude-sonnet-4-6",
      },
      ctx.db,
    );

    expect(prompt.system).not.toContain("### Prior workflows");
    expect(prompt.included_prior_workflow_slugs).toEqual([]);
    expect(prompt.token_counts.prior_workflows).toBe(0);
  });
});
