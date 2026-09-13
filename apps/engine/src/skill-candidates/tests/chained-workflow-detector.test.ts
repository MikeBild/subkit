// chained-workflow-pattern detector — reads the discovery envelopes
// stashed by `discover_systems_from_files` and emits one Skill Candidate
// per unique cross-system data flow.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { tenants } from "../../db/schema/identity.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { detectChainedWorkflowPatterns } from "../detectors/chained-workflow-pattern.ts";

const TEST_NOW_MS = getTestNow();

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("chained_workflow_detector");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-cwd", display_name: "T cwd" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(async () => {
  await ctx.db.delete(knowledgeChunks);
  await ctx.db.delete(knowledgeSources).where(eq(knowledgeSources.tenant_id, tenant_id));
});

interface Envelope {
  candidates: Array<{
    name: string;
    kind: string;
    base_url_guess: string | null;
    endpoints: Array<{ method: string; path: string; summary: string }>;
    auth_kind: string;
    data_flow_summary: string;
    data_flow_role: string;
    capabilities: string[];
  }>;
  potential_connections: Array<{
    from_system: string;
    to_system: string;
    data_type: string;
    direction: string;
    evidence: string | null;
  }>;
}

async function seedEnvelope(envelope: Envelope, slugSuffix: string): Promise<string> {
  const json = JSON.stringify(envelope);
  const [src] = await ctx.db
    .insert(knowledgeSources)
    .values({
      tenant_id,
      name: `cands-${slugSuffix}`,
      slug: `endpoint-candidates-${slugSuffix}`,
      scope: "global",
      status: "active",
      source_type: "connector_endpoint_candidates",
      source_uri: "test-source",
      mime_type: "application/json",
      version: `v-${slugSuffix}`,
      bytes_total: json.length,
      chunk_count: 1,
      last_refreshed_at: new Date(TEST_NOW_MS),
    })
    .returning();
  await ctx.db.insert(knowledgeChunks).values({
    tenant_id,
    knowledge_source_id: src!.id,
    ordinal: 0,
    title: "envelope",
    path: "envelope",
    content: json,
    byte_size: json.length,
    fingerprint: `fp-${slugSuffix}`,
  });
  return src!.id;
}

describe("detectChainedWorkflowPatterns", () => {
  test("returns no signals when there are no candidate envelopes", async () => {
    const signals = await detectChainedWorkflowPatterns(tenant_id, ctx.db);
    expect(signals).toHaveLength(0);
  });

  test("returns no signals when envelopes carry no potential_connections", async () => {
    await seedEnvelope(
      {
        candidates: [
          {
            name: "Solo",
            kind: "http",
            base_url_guess: "https://solo.example.test",
            endpoints: [],
            auth_kind: "none",
            data_flow_summary: "alone",
            data_flow_role: "source",
            capabilities: ["read"],
          },
        ],
        potential_connections: [],
      },
      "solo",
    );
    const signals = await detectChainedWorkflowPatterns(tenant_id, ctx.db);
    expect(signals).toHaveLength(0);
  });

  test("emits one signal per unique chain with high confidence when capabilities align", async () => {
    await seedEnvelope(
      {
        candidates: [
          {
            name: "Stripe",
            kind: "http",
            base_url_guess: "https://api.stripe.com",
            endpoints: [],
            auth_kind: "bearer",
            data_flow_summary: "billing source",
            data_flow_role: "source",
            capabilities: ["read", "webhook"],
          },
          {
            name: "HubSpot",
            kind: "http",
            base_url_guess: "https://api.hubapi.com",
            endpoints: [],
            auth_kind: "oauth2",
            data_flow_summary: "CRM sink",
            data_flow_role: "destination",
            capabilities: ["write"],
          },
        ],
        potential_connections: [
          {
            from_system: "Stripe",
            to_system: "HubSpot",
            data_type: "charges → deals",
            direction: "one_way",
            evidence: "Stripe charges become HubSpot deals.",
          },
        ],
      },
      "stripe-hubspot",
    );

    const signals = await detectChainedWorkflowPatterns(tenant_id, ctx.db);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.pattern_kind).toBe("chained_workflow_pattern");
    expect(s.scope).toBe("global");
    expect(s.title).toContain("Stripe");
    expect(s.title).toContain("HubSpot");
    expect(s.title).toContain("charges");
    expect(s.body).toContain("Capability alignment is clean");
    // Aligned + 1 envelope of evidence still yields low (count < 5),
    // but the consistency ratio is 1.0. Confidence floor is "low" until
    // the chain shows up in multiple envelopes — which we test below.
    expect(s.confidence).toBe("low");
  });

  test("aggregates the same chain across multiple envelopes (evidence diversity)", async () => {
    const envelope = (suffix: string): Envelope => ({
      candidates: [
        {
          name: "Stripe",
          kind: "http",
          base_url_guess: null,
          endpoints: [],
          auth_kind: "bearer",
          data_flow_summary: "billing",
          data_flow_role: "source",
          capabilities: ["read"],
        },
        {
          name: "HubSpot",
          kind: "http",
          base_url_guess: null,
          endpoints: [],
          auth_kind: "oauth2",
          data_flow_summary: "CRM",
          data_flow_role: "destination",
          capabilities: ["write"],
        },
      ],
      potential_connections: [
        {
          from_system: "Stripe",
          to_system: "HubSpot",
          data_type: "charges → deals",
          direction: "one_way",
          evidence: `seen in ${suffix}`,
        },
      ],
    });
    for (let i = 0; i < 5; i++) {
      await seedEnvelope(envelope(String(i)), `mention-${i}`);
    }
    const signals = await detectChainedWorkflowPatterns(tenant_id, ctx.db);
    expect(signals).toHaveLength(1);
    // 5 distinct envelopes + clean capability alignment ⇒ medium
    // confidence (>= 5 evidence and >= 0.8 ratio).
    expect(signals[0]!.confidence).toBe("medium");
    expect(signals[0]!.evidence.length).toBeGreaterThanOrEqual(5);
  });

  test("two distinct chains in the same envelope produce two signals with distinct fingerprints", async () => {
    await seedEnvelope(
      {
        candidates: [
          {
            name: "Stripe",
            kind: "http",
            base_url_guess: null,
            endpoints: [],
            auth_kind: "bearer",
            data_flow_summary: "billing",
            data_flow_role: "source",
            capabilities: ["read"],
          },
          {
            name: "HubSpot",
            kind: "http",
            base_url_guess: null,
            endpoints: [],
            auth_kind: "oauth2",
            data_flow_summary: "CRM",
            data_flow_role: "destination",
            capabilities: ["write"],
          },
          {
            name: "Slack",
            kind: "http",
            base_url_guess: null,
            endpoints: [],
            auth_kind: "bearer",
            data_flow_summary: "notifications",
            data_flow_role: "destination",
            capabilities: ["write"],
          },
        ],
        potential_connections: [
          {
            from_system: "Stripe",
            to_system: "HubSpot",
            data_type: "charges",
            direction: "one_way",
            evidence: null,
          },
          {
            from_system: "Stripe",
            to_system: "Slack",
            data_type: "alerts",
            direction: "one_way",
            evidence: null,
          },
        ],
      },
      "two-chains",
    );
    const signals = await detectChainedWorkflowPatterns(tenant_id, ctx.db);
    expect(signals).toHaveLength(2);
    const fps = signals.map((s) => s.fingerprint);
    expect(new Set(fps).size).toBe(2);
  });
});
