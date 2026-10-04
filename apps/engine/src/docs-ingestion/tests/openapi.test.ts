import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectorDocumentChunks, connectorDocuments } from "../../db/schema/index.ts";
import { ingestDocs } from "../service.ts";
import { createDocsTestCtx, type DocsTestCtx, stubFetch } from "./setup.ts";

const TINY_OPENAPI = {
  openapi: "3.0.0",
  info: { title: "Pet API", version: "1.0.0", description: "Pets for adoption." },
  servers: [{ url: "https://petstore.test/v1" }],
  paths: {
    "/pet": {
      get: {
        summary: "List pets",
        operationId: "listPets",
        parameters: [{ name: "limit", in: "query", description: "max pets" }],
        responses: { "200": { description: "ok" } },
      },
      post: {
        summary: "Create a pet",
        operationId: "createPet",
        responses: { "201": { description: "created" } },
      },
    },
    "/pet/{id}": {
      get: {
        summary: "Fetch a pet",
        operationId: "getPet",
        parameters: [{ name: "id", in: "path", description: "pet id" }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" } },
      },
    },
  },
};

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("openapi");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/openapi", () => {
  test("ingests a tiny OpenAPI spec into chunks + document row", async () => {
    const url = "https://petstore.test/swagger.json";
    const fetchImpl = stubFetch({
      [url]: { body: JSON.stringify(TINY_OPENAPI) },
    });
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "openapi", url },
        fetchImpl,
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBe(5);
    expect(result.budget_exceeded).toBe(false);
    expect(result.total_bytes).toBeGreaterThan(0);

    const [doc] = await ctx.testDb.db
      .select()
      .from(connectorDocuments)
      .where(
        and(
          eq(connectorDocuments.tenant_id, ctx.tenantId),
          eq(connectorDocuments.connector_id, ctx.connectorId),
        ),
      );
    expect(doc).toBeTruthy();
    expect(doc?.chunk_count).toBe(5);
    expect(doc?.source_type).toBe("openapi");

    const chunks = await ctx.testDb.db
      .select()
      .from(connectorDocumentChunks)
      .where(
        and(
          eq(connectorDocumentChunks.tenant_id, ctx.tenantId),
          eq(connectorDocumentChunks.connector_id, ctx.connectorId),
        ),
      );
    expect(chunks.length).toBe(5);
    const operationPaths = chunks.map((c) => c.path).filter((p): p is string => !!p);
    expect(operationPaths).toContain("paths./pet.get");
    expect(operationPaths).toContain("paths./pet.post");
    expect(operationPaths).toContain("components.schemas.Pet");
  });
});
