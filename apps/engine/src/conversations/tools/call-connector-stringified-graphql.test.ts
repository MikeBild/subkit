// call_connector — stringified GraphQL body acceptance tests (P3).
//
// The `body` input schema was changed from `z.unknown()` to
// `z.union([z.object({}).passthrough(), z.string()])`. An MCP client that
// serializes the object to a JSON string must still reach dispatch, and
// the `{query}` presence check must parse the string before evaluating it.
//
// Three cases:
//   1. Object body `{query, variables}` → dispatches to the graphql driver.
//   2. JSON-string body `'{"query":"{ x }","variables":{}}'` → same dispatch.
//   3. Non-JSON string (e.g. "not-an-object") → invalid_input, no dispatch.
//
// The graphql driver is replaced with a spy so no live endpoint is
// contacted; we assert the spy was invoked with the correct parsed body.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import * as graphqlDriver from "../../connectors/drivers/graphql.ts";
import { connectors } from "../../db/schema/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import { callConnectorTool } from "./call-connector.ts";
import type { ToolContext } from "./index.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("call_connector_graphql_str");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedGraphqlConnector(slug: string): Promise<string> {
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
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

function makeToolCtx(): ToolContext {
  const { EngineClient } = require("../../engine-client/index.ts");
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: test isolation
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

/** Minimal stub for graphqlDriver.query that returns a successful response. */
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
  });
}

describe("call_connector — GraphQL: object body", () => {
  test("body as object {query, variables} dispatches to graphql driver", async () => {
    const connectorId = await seedGraphqlConnector("gql-obj-body");
    const spy = mockGraphqlSuccess();

    const result = await callConnectorTool.execute(makeToolCtx(), {
      connector_id: connectorId,
      method: "POST",
      path: "/graphql",
      body: { query: "{ x }", variables: { id: "abc" } },
    });

    expect(result.ok).toBe(true);
    // Driver was called once with the expected query.
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as { query: string; variables?: Record<string, unknown> };
    expect(call.query).toBe("{ x }");
    expect(call.variables?.id).toBe("abc");

    spy.mockRestore();
  });
});

describe("call_connector — GraphQL: JSON-stringified body", () => {
  test('body as JSON string \'{"query":"{ x }","variables":{}}\' dispatches without invalid_input', async () => {
    const connectorId = await seedGraphqlConnector("gql-str-body");
    const spy = mockGraphqlSuccess();

    const bodyString = JSON.stringify({ query: "{ x }", variables: {} });
    const result = await callConnectorTool.execute(makeToolCtx(), {
      connector_id: connectorId,
      method: "POST",
      path: "/graphql",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately testing the string-body path
      body: bodyString as any,
    });

    // Must NOT return invalid_input — the string was successfully parsed.
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect((data.error as { code: string } | undefined)?.code).not.toBe("invalid_input");

    // Driver was called once — dispatch reached the wire.
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as { query: string };
    expect(call.query).toBe("{ x }");

    spy.mockRestore();
  });

  test("body as JSON string with nested variables passes them through correctly", async () => {
    const connectorId = await seedGraphqlConnector("gql-str-vars");
    const spy = mockGraphqlSuccess();

    const bodyString = JSON.stringify({
      query: "query Q($id: ID!) { user(id: $id) { name } }",
      variables: { id: "u-42" },
    });
    const result = await callConnectorTool.execute(makeToolCtx(), {
      connector_id: connectorId,
      method: "POST",
      path: "/graphql",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing string-body path
      body: bodyString as any,
    });

    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as { query: string; variables?: Record<string, unknown> };
    expect(call.query).toContain("user(id: $id)");
    expect(call.variables?.id).toBe("u-42");

    spy.mockRestore();
  });
});

describe("call_connector — GraphQL: non-JSON string body fails cleanly", () => {
  test('non-JSON string "not-an-object" returns invalid_input, driver never called', async () => {
    const connectorId = await seedGraphqlConnector("gql-bad-str");
    const spy = mockGraphqlSuccess();

    const result = await callConnectorTool.execute(makeToolCtx(), {
      connector_id: connectorId,
      method: "POST",
      path: "/graphql",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately testing invalid-string path
      body: "not-an-object" as any,
    });

    expect(result.ok).toBe(false);
    const data = result.data as { error: { code: string } };
    expect(data.error.code).toBe("invalid_input");

    // Driver must NOT have been called — validation failed before dispatch.
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  test("JSON string missing query field returns invalid_input", async () => {
    const connectorId = await seedGraphqlConnector("gql-missing-query");
    const spy = mockGraphqlSuccess();

    // Valid JSON but missing the `query` field — the guard must still reject.
    const bodyString = JSON.stringify({ variables: { id: "x" } });
    const result = await callConnectorTool.execute(makeToolCtx(), {
      connector_id: connectorId,
      method: "POST",
      path: "/graphql",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing missing-query path
      body: bodyString as any,
    });

    expect(result.ok).toBe(false);
    const data = result.data as { error: { code: string } };
    expect(data.error.code).toBe("invalid_input");
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
