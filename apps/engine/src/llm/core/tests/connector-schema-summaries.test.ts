// OPT-E: `loadConnectorSchemaSummaries` — surfaces a connector's KNOWN
// operations (from its cached discovery/introspection index) into the authoring
// context, so the model uses real operation + argument names without a
// discover_connector_endpoints round-trip.
//
// Verifies against a real Postgres database:
//   - operations are projected as `op(arg: Type, …)` from the discovery index;
//   - tenant isolation: tenant B's index NEVER loads for tenant A;
//   - a connector with no cached index yields [] (no throw);
//   - non-UUID ids are filtered.
// Plus a pure-render assertion on `formatConnectorSchemaSummaries`.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryModule from "../../../connectors/discovery/index.ts";
import { runDiscoveryCached } from "../../../connectors/discovery/service.ts";
import type { DiscoveryResult } from "../../../connectors/discovery/types.ts";
import { connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
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
  const [ta] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-sch-a", display_name: "Schema Tenant A" })
    .returning();
  const [tb] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-sch-b", display_name: "Schema Tenant B" })
    .returning();
  tenantA = ta!.id;
  tenantB = tb!.id;
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

  // Warm tenant A's discovery index for that base_url (spy avoids real network).
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
    // Tenant B has no warmed index (only A was warmed). Same base_url, but the
    // index read is tenant-scoped, so B sees nothing.
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
