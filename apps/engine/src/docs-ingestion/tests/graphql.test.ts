import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ingestDocs } from "../service.ts";
import { createDocsTestCtx, type DocsTestCtx, stubFetch } from "./setup.ts";

const SCHEMA = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          description: null,
          fields: [
            {
              name: "users",
              description: "List users",
              args: [{ name: "limit", description: null, type: { kind: "SCALAR", name: "Int" } }],
              type: {
                kind: "LIST",
                name: null,
                ofType: { kind: "OBJECT", name: "User" },
              },
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "Mutation",
          description: null,
          fields: [
            {
              name: "createUser",
              description: null,
              args: [{ name: "name", description: null, type: { kind: "SCALAR", name: "String" } }],
              type: { kind: "OBJECT", name: "User" },
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "User",
          description: "A user account",
          fields: [
            {
              name: "id",
              description: null,
              type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } },
            },
            { name: "name", description: null, type: { kind: "SCALAR", name: "String" } },
          ],
        },
        {
          kind: "ENUM",
          name: "Role",
          description: "Role enum",
          enumValues: [{ name: "ADMIN" }, { name: "MEMBER" }],
        },
      ],
    },
  },
};

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("graphql");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/graphql", () => {
  test("ingests a graphql introspection schema into chunks", async () => {
    const url = "https://gql.test/graphql";
    const fetchImpl = stubFetch({ [url]: { body: JSON.stringify(SCHEMA) } });
    const result = await ingestDocs(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        input: { source_type: "graphql", url },
        fetchImpl,
      },
      ctx.testDb.db,
    );
    expect(result.ingested_count).toBeGreaterThanOrEqual(6);
    expect(result.budget_exceeded).toBe(false);
  });
});
