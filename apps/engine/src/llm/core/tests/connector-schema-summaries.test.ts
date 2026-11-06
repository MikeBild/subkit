import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryModule from "../../../connectors/discovery/index.ts";
import { runDiscoveryCached } from "../../../connectors/discovery/service.ts";
import type { DiscoveryResult } from "../../../connectors/discovery/types.ts";
import { connectors } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { formatConnectorSchemaSummaries } from "../context-assembler/formatters.ts";
import { loadConnectorSchemaSummaries } from "../context-assembler/loaders.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;
let connectorA: string;
let connectorB: string;

const GQL_INDEX: DiscoveryResult = {
  source_url: "https://api.example.test/graphql",
  fetched_at: "2026-04-26T00:00:00.000Z",
  strategy: "graphql-introspect",
  spec_version: null,
  title: "Example GraphQL",
  servers: ["https://api.example.test/graphql"],
  auth_schemes: [],
  endpoints: [
    {
      method: "POST",
      path: "/graphql",
      summary: "things",
      description: null,
      operation_id: "things",
      scopes: [],
      params: [
        { name: "filter", in: "body", required: false, type: "ThingFilter" },
        { name: "orderBy", in: "body", required: false, type: "ThingOrderBy" },
        { name: "first", in: "body", required: false, type: "Int" },
      ],
      request_body_schema: null,
      request_content_type: null,
      response_schemas: { "200": { type: "object" } },
      pagination_hint: null,
      deprecated: false,
    },
  ],
  warnings: [],
};

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("connector_schema_summaries");
  const ta = await seedTenant(ctx.db, { slug: "t-sch-a", display_name: "Schema Tenant A" });
  const tb = await seedTenant(ctx.db, { slug: "t-sch-b", display_name: "Schema Tenant B" });
  tenantA = ta.id;
  tenantB = tb.id;
  const [ca] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantA,
      slug: "example-gql",
      display_name: "Example GQL",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.example.test/graphql",
    })
    .returning();
  const [cb] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantB,
      slug: "example-gql-b",
      display_name: "Example GQL B",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.example.test/graphql",
    })
    .returning();
  connectorA = ca!.id;
  connectorB = cb!.id;

  const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(GQL_INDEX);
  try {
    await runDiscoveryCached(
      { db: ctx.db, tenant_id: tenantA, actor_id: null },
      { base_url: "https://api.example.test/graphql" },
    );
  } finally {
    spy.mockRestore();
  }
});

afterAll(async () => {
  if (!skip) await ctx.cleanup();
});

describe.skipIf(skip)("loadConnectorSchemaSummaries (OPT-E)", () => {
  test("projects op(arg: Type, …) signatures from the discovery index", async () => {
    const out = await loadConnectorSchemaSummaries(tenantA, [connectorA], ctx.db);
    expect(out).toHaveLength(1);
    expect(out[0]?.connector_slug).toBe("example-gql");
    expect(out[0]?.operations[0]).toBe(
      "things(filter: ThingFilter, orderBy: ThingOrderBy, first: Int)",
    );
  });

  test("tenant isolation: tenant B's connector yields nothing for tenant A's index lookup", async () => {
    const out = await loadConnectorSchemaSummaries(tenantB, [connectorB], ctx.db);
    expect(out).toEqual([]);
  });

  test("non-UUID ids are filtered without error", async () => {
    const out = await loadConnectorSchemaSummaries(
      tenantA,
      ["not-a-uuid-recipe-placeholder"],
      ctx.db,
    );
    expect(out).toEqual([]);
  });

  test("formatConnectorSchemaSummaries renders a labeled operations block", () => {
    const block = formatConnectorSchemaSummaries([
      { connector_slug: "example-gql", operations: ["things(filter: ThingFilter)"] },
    ]);
    expect(block).toContain("Connector operations");
    expect(block).toContain("## example-gql");
    expect(block).toContain("- things(filter: ThingFilter)");
  });
});
