// Postgres `information_schema` source ingestion test.
//
// Uses the test-isolation database scaffolded by createDocsTestCtx, which
// already runs the full migration bundle so there are dozens of tables
// to walk. We just call the orchestrator with the test database's URL
// and assert at least one chunk lands.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ingestDocs } from "../service.ts";
import { createDocsTestCtx, type DocsTestCtx } from "./setup.ts";

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("postgres");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/postgres", () => {
  test("ingests information_schema and emits at least one table chunk", async () => {
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "postgres", url: ctx.testDb.url, schemas: ["subkit"] },
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(1);
    expect(result.total_bytes).toBeGreaterThan(0);
    expect(result.source_type).toBe("postgres");
  });
});
