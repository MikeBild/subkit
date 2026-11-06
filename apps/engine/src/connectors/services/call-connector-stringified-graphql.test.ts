import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import * as graphqlDriver from "../drivers/graphql.ts";
import { type CallConnectorRequest, callConnector } from "./call-connector.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("svc_call_connector_gql_str");

  tenant_id = (
    await seedTenant(testDb.db, { slug: "t-svc-gql-str", display_name: "T-SVC-GQL-STR" })
  ).id;
});

afterAll(async () => {
  await testDb.cleanup();
});

async function seedGraphqlConnector(slug: string): Promise<string> {
  const [c] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: "https://graphql.example.test/graphql",
      config: {},
    })
    .returning({ id: connectors.id });
  return c!.id;
}

function baseReq(connectorId: string): CallConnectorRequest {
  return {
    db: testDb.db,
    tenant_id,
    actor_id: null,
    connector_id: connectorId,
    method: "POST",
    path: "/graphql",
  };
}

function mockGraphqlSuccess() {
  return spyOn(graphqlDriver, "query").mockResolvedValue({
    status: 200,
    headers: { "content-type": "application/json" },
    body: { data: { x: 1 } },
    bytes_in: 100,
    duration_ms: 10,
    operation_name: "Q",
    credential_id: null,
    auth_method: "none" as const,
    stored_credential_used: false,
  });
}

describe("callConnector service — GraphQL: object body dispatches", () => {
  test("object body {query, variables} reaches graphqlQuery", async () => {
    const connectorId = await seedGraphqlConnector("svc-gql-obj");
    const spy = mockGraphqlSuccess();

    const result = await callConnector({
      ...baseReq(connectorId),
      body: { query: "{ x }", variables: { id: "abc" } },
    });

    expect(result.kind).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as { query: string; variables?: Record<string, unknown> };
    expect(call.query).toBe("{ x }");
    expect(call.variables?.id).toBe("abc");

    spy.mockRestore();
  });
});

describe("callConnector service — GraphQL: JSON-string body dispatches", () => {
  test('JSON string \'{"query":"{ x }","variables":{}}\' parses and dispatches', async () => {
    const connectorId = await seedGraphqlConnector("svc-gql-str");
    const spy = mockGraphqlSuccess();

    const bodyString = JSON.stringify({ query: "{ x }", variables: { id: "str-test" } });
    const result = await callConnector({
      ...baseReq(connectorId),
      body: bodyString,
    });

    expect(result.kind).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as { query: string; variables?: Record<string, unknown> };
    expect(call.query).toBe("{ x }");
    expect(call.variables?.id).toBe("str-test");

    spy.mockRestore();
  });

  test("JSON string with nested variables passes them through", async () => {
    const connectorId = await seedGraphqlConnector("svc-gql-str-vars");
    const spy = mockGraphqlSuccess();

    const bodyString = JSON.stringify({
      query: "query Q($uid: ID!) { user(id: $uid) { email } }",
      variables: { uid: "u-99" },
    });
    const result = await callConnector({
      ...baseReq(connectorId),
      body: bodyString,
    });

    expect(result.kind).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as { query: string; variables?: Record<string, unknown> };
    expect(call.query).toContain("user(id: $uid)");
    expect(call.variables?.uid).toBe("u-99");

    spy.mockRestore();
  });
});

describe("callConnector service — GraphQL: non-JSON string fails cleanly", () => {
  test('non-JSON string "not-an-object" returns invalid_input, graphqlQuery never called', async () => {
    const connectorId = await seedGraphqlConnector("svc-gql-bad-str");
    const spy = mockGraphqlSuccess();

    const result = await callConnector({
      ...baseReq(connectorId),
      body: "not-an-object",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error_code).toBe("invalid_input");
      expect(result.message).toMatch(/query/i);
    }
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  test("JSON string without a query field returns invalid_input", async () => {
    const connectorId = await seedGraphqlConnector("svc-gql-no-query");
    const spy = mockGraphqlSuccess();

    const bodyString = JSON.stringify({ variables: { id: "x" } });
    const result = await callConnector({
      ...baseReq(connectorId),
      body: bodyString,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error_code).toBe("invalid_input");
    }
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
