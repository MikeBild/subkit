// findSimilarActive — stage-1 in-process ranker over active workflows.
// Pins the score formula's ordering contract (connector overlap > keyword
// overlap > step overlap > step-count affinity; slug-ascending tiebreak)
// and the exclusion + cap behaviour the assembler relies on.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createSeededRandom } from "../../test-helpers/determinism/random.ts";
import { findSimilarActive } from "../prior-workflows.ts";
import { createWorkflow } from "../service.ts";

let ctx: TestDb;
const rng = createSeededRandom(0xf1_5_4ac7);

beforeAll(async () => {
  ctx = await createTestDb("find_similar_active");
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

const stripeConnectorId = "00000000-0000-4000-8000-000000000001";
const slackConnectorId = "00000000-0000-4000-8000-000000000002";
const hubspotConnectorId = "00000000-0000-4000-8000-000000000003";

async function seed(tenant_id: string, def: Record<string, unknown>): Promise<string> {
  const r = await createWorkflow({ tenant_id, def, actor_id: null }, ctx.db);
  if ("errors" in r) throw new Error(`seed failed: ${r.errors.join("; ")}`);
  return r.workflow.id;
}

describe("findSimilarActive · stage-1 ranking", () => {
  test("returns [] for a tenant with no workflows", async () => {
    const tenant_id = await newTenant("empty");
    const refs = await findSimilarActive(
      tenant_id,
      { query: "stripe webhook", connector_ids: [stripeConnectorId] },
      3,
      ctx.db,
    );
    expect(refs).toEqual([]);
  });

  test("connector overlap dominates keyword overlap", async () => {
    const tenant_id = await newTenant("connector-overlap");

    // Workflow A: matches via Stripe connector, generic name.
    await seed(tenant_id, {
      name: "Generic payment handler",
      slug: "wf-connector-match",
      steps: [
        {
          id: "ingest",
          kind: "request",
          method: "POST",
          url: "https://api.stripe.com/v1/events",
          connector_id: stripeConnectorId,
        },
      ],
    });
    // Workflow B: matches via name keywords ("stripe webhook"), DIFFERENT
    // connector. Connector boost (weight 4) must beat name+desc boost
    // (weight 2 × token-overlap).
    await seed(tenant_id, {
      name: "Stripe webhook documentation index",
      slug: "wf-keyword-match",
      description: "Inventories the stripe webhook events catalogued in confluence.",
      steps: [
        {
          id: "list",
          kind: "request",
          method: "GET",
          url: "https://api.hubspot.com/crm/v3/objects",
          connector_id: hubspotConnectorId,
        },
      ],
    });

    const refs = await findSimilarActive(
      tenant_id,
      {
        query: "stripe webhook charge succeeded",
        connector_ids: [stripeConnectorId],
      },
      3,
      ctx.db,
    );

    expect(refs.length).toBe(2);
    expect(refs[0]?.slug).toBe("wf-connector-match");
    expect(refs[1]?.slug).toBe("wf-keyword-match");
  });

  test("slug ascending tiebreak when scores are equal", async () => {
    const tenant_id = await newTenant("slug-tiebreak");

    // Identical-shape workflows: same connector (no overlap with the
    // intent), same trivial steps, no keyword matches → equal score.
    await seed(tenant_id, {
      name: "Bravo",
      slug: "wf-bravo",
      steps: [{ id: "s", kind: "transform", language: "javascript", expression: "$" }],
    });
    await seed(tenant_id, {
      name: "Alpha",
      slug: "wf-alpha",
      steps: [{ id: "s", kind: "transform", language: "javascript", expression: "$" }],
    });

    const refs = await findSimilarActive(
      tenant_id,
      { query: "completely unrelated intent", connector_ids: [] },
      5,
      ctx.db,
    );

    expect(refs.map((r) => r.slug)).toEqual(["wf-alpha", "wf-bravo"]);
  });

  test("excludes the workflow currently being edited", async () => {
    const tenant_id = await newTenant("exclude-self");
    const editedId = await seed(tenant_id, {
      name: "Currently being edited",
      slug: "wf-self",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://api.stripe.com/v1/charges",
          connector_id: stripeConnectorId,
        },
      ],
    });
    await seed(tenant_id, {
      name: "Sibling Stripe handler",
      slug: "wf-sibling",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "POST",
          url: "https://api.stripe.com/v1/events",
          connector_id: stripeConnectorId,
        },
      ],
    });

    const refs = await findSimilarActive(
      tenant_id,
      {
        query: "stripe events",
        connector_ids: [stripeConnectorId],
        exclude_workflow_id: editedId,
      },
      3,
      ctx.db,
    );

    expect(refs.map((r) => r.slug)).toEqual(["wf-sibling"]);
    expect(refs.find((r) => r.id === editedId)).toBeUndefined();
  });

  test("caps result list at `k` items", async () => {
    const tenant_id = await newTenant("cap-k");
    for (let i = 0; i < 5; i += 1) {
      await seed(tenant_id, {
        name: `Stripe job ${i}`,
        slug: `wf-stripe-${i}`,
        steps: [
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            url: "https://api.stripe.com/v1/events",
            connector_id: stripeConnectorId,
          },
        ],
      });
    }

    const refs = await findSimilarActive(
      tenant_id,
      { query: "stripe", connector_ids: [stripeConnectorId] },
      3,
      ctx.db,
    );

    expect(refs.length).toBe(3);
  });

  test("projects trigger summary + step topology + output keys", async () => {
    const tenant_id = await newTenant("projection");
    await seed(tenant_id, {
      name: "Stripe webhook → Slack",
      slug: "wf-stripe-slack",
      description: "Notify #ops when a Stripe charge succeeds.",
      trigger: {
        kind: "webhook",
        source: "stripe",
        events: ["charge.succeeded"],
        verify: "stripe-signature",
      },
      output_schema: {
        type: "object",
        properties: {
          channel: { type: "string" },
          message_ts: { type: "string" },
          amount: { type: "number" },
        },
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
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "$",
        },
        {
          id: "post",
          kind: "request",
          method: "POST",
          url: "https://slack.com/api/chat.postMessage",
          connector_id: slackConnectorId,
        },
      ],
    });

    const [ref] = await findSimilarActive(
      tenant_id,
      { query: "stripe charge slack notification", connector_ids: [stripeConnectorId] },
      3,
      ctx.db,
    );

    expect(ref).toBeDefined();
    expect(ref?.trigger_summary).toBe("webhook (stripe)");
    expect(ref?.step_topology).toEqual([
      {
        kind: "request",
        connector_id: stripeConnectorId,
        action: "POST https://api.stripe.com/v1/events",
      },
      { kind: "transform" },
      {
        kind: "request",
        connector_id: slackConnectorId,
        action: "POST https://slack.com/api/chat.postMessage",
      },
    ]);
    // Postgres jsonb storage sorts object keys at the binary level, so
    // `properties` order is alphabetical by the time it round-trips —
    // assert as a set, not an ordered list.
    expect(new Set(ref?.output_keys)).toEqual(new Set(["channel", "message_ts", "amount"]));
    expect(ref?.description).toBe("Notify #ops when a Stripe charge succeeds.");
  });

  test("never surfaces another tenant's workflows (cross-tenant isolation)", async () => {
    // Load-bearing pin against silent regressions in the read path. If
    // anyone refactors `listWorkflows`' tenant predicate, this test is
    // the new ranker's last line of defence — without it the leak would
    // only surface in the prompt-assembly integration test, which is
    // less obviously about tenant scoping.
    const tenant_a = await newTenant("iso-a");
    const tenant_b = await newTenant("iso-b");

    await seed(tenant_a, {
      name: "A-only Stripe handler",
      slug: "wf-a-only-stripe",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://api.stripe.com/v1/charges",
          connector_id: stripeConnectorId,
        },
      ],
    });

    const refs = await findSimilarActive(
      tenant_b,
      { query: "stripe charges", connector_ids: [stripeConnectorId] },
      3,
      ctx.db,
    );

    expect(refs).toEqual([]);
  });

  test("k=0 honours caller intent and returns []", async () => {
    // S1: `Math.max(0, k)` lets callers disable the section via the
    // existing `k` knob (e.g. an A/B flag) without unwiring the loader.
    // The previous `Math.max(1, k)` floor silently returned a single
    // ref instead.
    const tenant_id = await newTenant("k-zero");
    await seed(tenant_id, {
      name: "Some workflow",
      slug: "wf-some",
      steps: [{ id: "s", kind: "transform", language: "javascript", expression: "$" }],
    });

    const refs = await findSimilarActive(
      tenant_id,
      { query: "anything", connector_ids: [] },
      0,
      ctx.db,
    );

    expect(refs).toEqual([]);
  });

  test("output_keys returns [] for a JSON-schema-shaped object without `.properties`", async () => {
    // S5: `deriveOutputKeys` falls back to top-level keys only when the
    // schema looks like a loose property map. A schema with `type:
    // "object"` but no `.properties` is JSON-schema-shaped and would
    // otherwise leak reserved keywords (`type`, `required`,
    // `additionalProperties`) as if they were workflow output keys.
    const tenant_id = await newTenant("output-keys-strict");
    await seed(tenant_id, {
      name: "Schema-without-properties",
      slug: "wf-schema-noprops",
      output_schema: {
        type: "object",
        required: ["whatever"],
        additionalProperties: false,
      },
      steps: [{ id: "s", kind: "transform", language: "javascript", expression: "$" }],
    });

    const [ref] = await findSimilarActive(
      tenant_id,
      { query: "schema test", connector_ids: [] },
      3,
      ctx.db,
    );

    expect(ref).toBeDefined();
    expect(ref?.output_keys).toEqual([]);
  });
});
