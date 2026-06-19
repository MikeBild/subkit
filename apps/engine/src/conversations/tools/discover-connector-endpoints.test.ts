// Unit tests for discover_connector_endpoints.
//
// Covers:
//   - cache miss → calls discovery, persists to knowledge_sources, returns "fresh"
//   - cache hit (within TTL) → returns "cache" and skips discovery
//   - force_refresh → bypasses cache even when fresh row exists
//   - DiscoveryError surfaces as structured tool error
//   - tenant isolation: tenant A's cached discovery is not returned for tenant B

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import { DiscoveryError, type DiscoveryResult } from "../../connectors/discovery/types.ts";
import { tenants } from "../../db/schema/identity.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  discoverConnectorEndpointsTool,
  KNOWLEDGE_SOURCE_TTL_MS,
} from "./discover-connector-endpoints.ts";
import type { ToolContext } from "./index.ts";

const TEST_NOW_MS = getTestNow();

let ctx: TestDb;
let tenant_id: string;
let other_tenant_id: string;

const SAMPLE_RESULT: DiscoveryResult = {
  source_url:
    "https://api-engineering.nyc3.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml",
  fetched_at: "2026-04-26T00:00:00.000Z",
  strategy: "openapi-direct",
  spec_version: "openapi-3",
  title: "DigitalOcean API",
  servers: ["https://api.digitalocean.com/v2"],
  auth_schemes: [
    {
      name: "bearer_auth",
      type: "http",
      scheme: "bearer",
    },
  ],
  endpoints: [
    {
      method: "GET",
      path: "/v2/account",
      summary: "Get user information",
      description: null,
      operation_id: "account_get",
      scopes: ["account:read"],
      params: [],
      request_body_schema: null,
      response_schemas: { "200": { type: "object" } },
      pagination_hint: null,
      deprecated: false,
    },
    {
      method: "GET",
      path: "/v2/projects",
      summary: "List projects",
      description: null,
      operation_id: "projects_list",
      scopes: ["project:read"],
      params: [
        { name: "page", in: "query", required: false, type: "integer" },
        { name: "per_page", in: "query", required: false, type: "integer" },
      ],
      request_body_schema: null,
      response_schemas: { "200": { type: "object" } },
      pagination_hint: { kind: "page", param_names: ["page", "per_page"] },
      deprecated: false,
    },
  ],
  warnings: [],
};

beforeAll(async () => {
  ctx = await createTestDb("discover_connector_endpoints");
  const [t1] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-disc-a", display_name: "T A" })
    .returning();
  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-disc-b", display_name: "T B" })
    .returning();
  tenant_id = t1!.id;
  other_tenant_id = t2!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(async () => {
  // Wipe cached rows between tests so each scenario starts clean.
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

describe("discover_connector_endpoints — cache miss", () => {
  test("calls discovery, persists result, returns source=fresh", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        template_id: "digitalocean",
        force_refresh: false,
      });
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: { source: string; result: DiscoveryResult } }).data;
      expect(data.source).toBe("fresh");
      expect(data.result.endpoints).toHaveLength(2);
      expect(data.result.endpoints[0]?.path).toBe("/v2/account");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ template_id: "digitalocean" });
      // The persisted row should exist + chunk content should be the JSON.
      const rows = await ctx.db
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.tenant_id, tenant_id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source_type).toBe("discovery_endpoint_index");
      expect(rows[0]?.slug).toBe("discovery-template-digitalocean");
      const chunks = await ctx.db
        .select()
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.knowledge_source_id, rows[0]!.id));
      expect(chunks).toHaveLength(1);
      const stored = JSON.parse(chunks[0]!.content) as DiscoveryResult;
      expect(stored.endpoints).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("DigitalOcean template id surfaces /v2/account + /v2/projects (the bug session 00b93a52 hit)", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        template_id: "digitalocean",
        force_refresh: false,
      });
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: { result: DiscoveryResult } }).data;
      const paths = data.result.endpoints.map((e) => e.path);
      expect(paths).toContain("/v2/account");
      expect(paths).toContain("/v2/projects");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("discover_connector_endpoints — cache hit", () => {
  test("returns source=cache without invoking discovery when row is fresh", async () => {
    // Seed a fresh cache row.
    const seed = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    await discoverConnectorEndpointsTool.execute(makeCtx(), {
      template_id: "digitalocean",
      force_refresh: false,
    });
    seed.mockRestore();

    // Now the next call must NOT touch discovery.
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockRejectedValue(
      new Error("must not be called"),
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        template_id: "digitalocean",
        force_refresh: false,
      });
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: { source: string; result: DiscoveryResult } }).data;
      expect(data.source).toBe("cache");
      expect(data.result.endpoints).toHaveLength(2);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("expired cache (older than TTL) re-fetches", async () => {
    // Seed an expired cache row directly.
    const stale = new Date(TEST_NOW_MS - KNOWLEDGE_SOURCE_TTL_MS - 1000);
    const [row] = await ctx.db
      .insert(knowledgeSources)
      .values({
        tenant_id,
        name: "old",
        slug: "discovery-template-digitalocean",
        scope: "global",
        status: "active",
        source_type: "discovery_endpoint_index",
        source_uri: "template:digitalocean",
        version: "stale",
        bytes_total: 0,
        chunk_count: 0,
        last_refreshed_at: stale,
      })
      .returning();
    await ctx.db.insert(knowledgeChunks).values({
      tenant_id,
      knowledge_source_id: row!.id,
      ordinal: 0,
      title: "stale",
      path: "template:digitalocean",
      content: JSON.stringify({ ...SAMPLE_RESULT, title: "stale" }),
      byte_size: 10,
      fingerprint: "stale",
    });

    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        template_id: "digitalocean",
        force_refresh: false,
      });
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: { source: string; result: DiscoveryResult } }).data;
      expect(data.source).toBe("fresh");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("discover_connector_endpoints — force_refresh", () => {
  test("bypasses fresh cache and re-invokes discovery", async () => {
    // Seed a fresh cache row.
    const seed = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    await discoverConnectorEndpointsTool.execute(makeCtx(), {
      template_id: "digitalocean",
      force_refresh: false,
    });
    seed.mockRestore();

    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue({
      ...SAMPLE_RESULT,
      title: "Refreshed Title",
    });
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        template_id: "digitalocean",
        force_refresh: true,
      });
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: { source: string; result: DiscoveryResult } }).data;
      expect(data.source).toBe("fresh");
      expect(data.result.title).toBe("Refreshed Title");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("discover_connector_endpoints — DiscoveryError", () => {
  test("returns structured error with next_best_actions", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockRejectedValue(
      new DiscoveryError("all_strategies_failed", "every strategy bailed"),
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        template_id: "digitalocean",
        force_refresh: false,
      });
      expect(r.ok).toBe(false);
      const fail = r as {
        ok: false;
        error_code?: string;
        message?: string;
        next_best_actions?: string[];
      };
      expect(fail.error_code).toBe("all_strategies_failed");
      expect(fail.message).toContain("every strategy bailed");
      expect(fail.next_best_actions).toEqual(["ask_user", "fetch_connector_docs"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("non-DiscoveryError still surfaces as structured error_code=discovery_failed", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockRejectedValue(
      new Error("network down"),
    );
    try {
      const r = await discoverConnectorEndpointsTool.execute(makeCtx(), {
        ingestion_url: "https://example.com/spec.json",
        force_refresh: false,
      });
      expect(r.ok).toBe(false);
      const fail = r as { ok: false; error_code?: string };
      expect(fail.error_code).toBe("discovery_failed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("discover_connector_endpoints — tenant isolation", () => {
  test("tenant A's cached discovery is not returned for tenant B", async () => {
    // Tenant A populates the cache.
    const seed = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    await discoverConnectorEndpointsTool.execute(makeCtx({ tenant_id }), {
      template_id: "digitalocean",
      force_refresh: false,
    });
    seed.mockRestore();

    // Tenant B asks for the same key — must miss and re-fetch.
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue({
      ...SAMPLE_RESULT,
      title: "Tenant B's view",
    });
    try {
      const r = await discoverConnectorEndpointsTool.execute(
        makeCtx({
          tenant_id: other_tenant_id,
          engineClient: new EngineClient({
            tenant_id: other_tenant_id,
            actor_id: null,
            db: ctx.db,
          }),
        }),
        { template_id: "digitalocean", force_refresh: false },
      );
      expect(r.ok).toBe(true);
      const data = (r as { ok: true; data: { source: string; result: DiscoveryResult } }).data;
      expect(data.source).toBe("fresh");
      expect(data.result.title).toBe("Tenant B's view");
      expect(spy).toHaveBeenCalledTimes(1);
      // Tenant A's row remains intact.
      const aRows = await ctx.db
        .select()
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, tenant_id),
            eq(knowledgeSources.slug, "discovery-template-digitalocean"),
          ),
        );
      expect(aRows).toHaveLength(1);
      // Tenant B got their own row.
      const bRows = await ctx.db
        .select()
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, other_tenant_id),
            eq(knowledgeSources.slug, "discovery-template-digitalocean"),
          ),
        );
      expect(bRows).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
