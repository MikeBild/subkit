import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import type { DiscoveredEndpoint, DiscoveryResult } from "../../connectors/discovery/types.ts";
import { tenants } from "../../db/schema/identity.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { discoverConnectorEndpointsTool } from "./discover-connector-endpoints.ts";
import type { ToolContext } from "./index.ts";

let ctx: TestDb;
let tenant_id: string;

function makeEndpoint(over: Partial<DiscoveredEndpoint> & { path: string }): DiscoveredEndpoint {
  return {
    method: "GET",
    path: over.path,
    summary: over.summary ?? null,
    description: over.description ?? null,
    operation_id: over.operation_id ?? null,
    scopes: over.scopes ?? [],
    params: over.params ?? [],
    request_body_schema: null,
    request_content_type: null,
    response_schemas: {},
    pagination_hint: null,
    deprecated: false,
  };
}

function buildSyntheticIndex(): DiscoveredEndpoint[] {
  const filler: DiscoveredEndpoint[] = Array.from({ length: 49 }, (_, i) =>
    makeEndpoint({
      path: `/v2/resource_${i}`,
      summary: `Resource ${i} list operation`,
      operation_id: `resource_${i}_list`,
    }),
  );
  const target = makeEndpoint({
    path: "/v2/droplets",
    summary: "List all droplets",
    description: "Returns droplets owned by the account.",
    operation_id: "droplets_list",
  });
  return [...filler.slice(0, 25), target, ...filler.slice(25)];
}

function buildResult(endpoints: DiscoveredEndpoint[]): DiscoveryResult {
  return {
    source_url: "https://api.digitalocean.com/v2/spec.json",
    fetched_at: "2026-04-26T00:00:00.000Z",
    strategy: "openapi-direct",
    spec_version: "openapi-3",
    title: "DigitalOcean API",
    servers: ["https://api.digitalocean.com/v2"],
    auth_schemes: [],
    endpoints,
    warnings: [],
  };
}

beforeAll(async () => {
  ctx = await createTestDb("discover_connector_endpoints_suggested");
  const [t1] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-disc-sug", display_name: "T Sug" })
    .returning();
  tenant_id = t1!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(async () => {
  await ctx.db.delete(knowledgeChunks);
  await ctx.db.delete(knowledgeSources);
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const base: ToolContext = {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
  return { ...base, ...overrides };
}

describe("discover_connector_endpoints — suggested_endpoints", () => {
  test("'list droplets' surfaces /v2/droplets as the top suggestion", async () => {
    const synthetic = buildSyntheticIndex();
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      buildResult(synthetic),
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(
        makeCtx({ recentUserMessage: "list droplets" }),
        { template_id: "digitalocean", force_refresh: false },
      );
      expect(r.ok).toBe(true);
      const data = (
        r as {
          ok: true;
          data: {
            suggested_endpoints?: Array<{
              endpoint: DiscoveredEndpoint;
              score: number;
              reasons: string[];
            }>;
          };
        }
      ).data;
      expect(data.suggested_endpoints).toBeDefined();
      expect(data.suggested_endpoints?.length).toBeGreaterThan(0);
      expect(data.suggested_endpoints?.length).toBeLessThanOrEqual(3);
      expect(data.suggested_endpoints?.[0]?.endpoint.path).toBe("/v2/droplets");
      expect((data.suggested_endpoints?.[0]?.score ?? 0) > 0).toBe(true);
      expect(data.suggested_endpoints?.[0]?.reasons.length ?? 0).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("no recentUserMessage → suggested_endpoints field omitted", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      buildResult(buildSyntheticIndex()),
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        template_id: "digitalocean",
        force_refresh: false,
      });
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: Record<string, unknown> }).data;
      expect("suggested_endpoints" in data).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("stop-words-only message → suggested_endpoints field omitted", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      buildResult(buildSyntheticIndex()),
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(
        makeCtx({ recentUserMessage: "get me all the" }),
        { template_id: "digitalocean", force_refresh: false },
      );
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: Record<string, unknown> }).data;
      expect("suggested_endpoints" in data).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("empty endpoints + no text_corpus → next_best_actions points to discover_systems_from_files", async () => {
    const empty: DiscoveryResult = {
      ...buildResult([]),
      text_corpus: null,
    };
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(empty);
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        template_id: "obscure-vendor",
        force_refresh: false,
      });
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: { next_best_actions?: string[] } }).data;
      expect(data.next_best_actions).toEqual(["discover_systems_from_files"]);
    } finally {
      spy.mockRestore();
    }
  });
});
